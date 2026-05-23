import { lstat, mkdir, open, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import {
  type EventId,
  type SessionId,
  type ThreadId,
  createId,
  nowIso,
  safeJsonStringify
} from "@nexus/shared";

export type NexusEventType =
  | "session.started"
  | "session.completed"
  | "user.input"
  | "assistant.message"
  | "assistant.delta"
  | "model.call.started"
  | "model.call.completed"
  | "model.call.failed"
  | "model.stream.started"
  | "model.stream.delta"
  | "model.stream.completed"
  | "model.usage"
  | "agent.step.started"
  | "agent.step.completed"
  | "agent.step.blocked"
  | "agent.loop.completed"
  | "agent.critic.completed"
  | "plan.updated"
  | "sdlc.goal.updated"
  | "sdlc.definition_of_done.updated"
  | "sdlc.stage.started"
  | "sdlc.stage.completed"
  | "sdlc.stage.blocked"
  | "tool.requested"
  | "tool.risk"
  | "tool.completed"
  | "approval.requested"
  | "approval.granted"
  | "approval.denied"
  | "approval.required"
  | "sandbox.unavailable"
  | "sandbox.denied"
  | "policy.denied"
  | "file.read"
  | "file.changed"
  | "checkpoint.created"
  | "rollback.started"
  | "rollback.completed"
  | "rollback.refused"
  | "patch.applied"
  | "shell.started"
  | "shell.output"
  | "shell.completed"
  | "git.status"
  | "git.diff"
  | "git.log"
  | "search.completed"
  | "verification.completed"
  | "review.completed"
  | "ship.completed"
  | "learning.candidate.created"
  | "learning.candidate.accepted"
  | "learning.candidate.rejected"
  | "memory.written"
  | "memory.updated"
  | "memory.deleted"
  | "eval.started"
  | "eval.completed"
  | "mcp.tool.started"
  | "mcp.tool.completed"
  | "subagent.started"
  | "subagent.completed"
  | "plan.approval.requested"
  | "plan.approval.completed"
  | "audit.recorded"
  | "hook.started"
  | "hook.completed"
  | "error";

export interface NexusEventBase {
  schemaVersion: 1;
  id: EventId;
  sessionId: SessionId;
  timestamp: string;
  type: NexusEventType;
  threadId?: ThreadId;
  parentEventId?: EventId;
  severity?: "debug" | "info" | "warning" | "error";
}

export type NexusEvent = NexusEventBase & Record<string, unknown>;
export type EventHandler = (event: NexusEvent) => void | Promise<void>;
export type Unsubscribe = () => void;

export interface EventBus {
  publish(event: NexusEvent): Promise<void>;
  subscribe(handler: EventHandler): Unsubscribe;
}

export interface JsonlEventWriterOptions {
  allowedRoot?: string;
  workspaceRoot?: string;
  lockTimeoutMs?: number;
  fsync?: boolean;
}

export interface CreateEventInput {
  sessionId: SessionId;
  type: NexusEventType;
  threadId?: ThreadId;
  parentEventId?: EventId;
  severity?: "debug" | "info" | "warning" | "error";
  data?: Record<string, unknown>;
}

export function createEvent(input: CreateEventInput): NexusEvent {
  return validateNexusEvent({
    schemaVersion: 1,
    id: createId("evt") as unknown as EventId,
    sessionId: input.sessionId,
    timestamp: nowIso(),
    type: input.type,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    ...(input.parentEventId ? { parentEventId: input.parentEventId } : {}),
    ...(input.severity ? { severity: input.severity } : {}),
    ...(input.data ?? {})
  });
}

export class InMemoryEventBus implements EventBus {
  private readonly handlers = new Set<EventHandler>();

  public subscribe(handler: EventHandler): Unsubscribe {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  public async publish(event: NexusEvent): Promise<void> {
    for (const handler of this.handlers) {
      await handler(event);
    }
  }
}

export class JsonlEventWriter {
  private queue: Promise<void> = Promise.resolve();

  public constructor(
    private readonly filePath: string,
    private readonly options: JsonlEventWriterOptions = {}
  ) {}

  public async write(event: NexusEvent): Promise<void> {
    const line = `${safeJsonStringify(validateNexusEvent(event))}\n`;
    const task = this.queue.then(() => this.writeLine(line));
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async writeLine(line: string): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await this.assertSafeEventPath();
    const lockPath = join(dirname(this.filePath), `.${basename(this.filePath)}.lock`);
    const lock = await acquireLock(lockPath, this.options.lockTimeoutMs ?? 5000);
    try {
      const handle = await open(this.filePath, "a");
      try {
        await handle.appendFile(line, "utf8");
        if (this.options.fsync !== false) {
          await handle.sync();
        }
      } finally {
        await handle.close();
      }
    } finally {
      await lock.close().catch(() => undefined);
      await rm(lockPath, { force: true }).catch(() => undefined);
    }
  }

  private async assertSafeEventPath(): Promise<void> {
    const parent = dirname(this.filePath);
    const parentMetadata = await lstat(parent).catch(() => undefined);
    if (parentMetadata?.isSymbolicLink()) {
      throw new Error("Event log parent must not be a symlink.");
    }
    const metadata = await lstat(this.filePath).catch(() => undefined);
    if (metadata?.isSymbolicLink()) {
      throw new Error("Event log path must not be a symlink.");
    }

    if (!this.options.allowedRoot || !this.options.workspaceRoot) {
      return;
    }
    const workspaceRoot = resolve(this.options.workspaceRoot);
    const allowedRoot = resolve(this.options.allowedRoot);
    const targetPath = resolve(this.filePath);
    if (!isInside(allowedRoot, workspaceRoot)) {
      throw new Error("Event log allowed root must be inside the workspace.");
    }
    if (!isInside(targetPath, allowedRoot)) {
      throw new Error("Event log path escapes the allowed root.");
    }
    const realAllowedRoot = await realpath(allowedRoot).catch(() => allowedRoot);
    const realParent = await realpath(parent).catch(() => parent);
    if (!isInside(realParent, realAllowedRoot)) {
      throw new Error("Event log parent resolves outside the allowed root.");
    }
  }
}

export async function readJsonlEvents(filePath: string): Promise<NexusEvent[]> {
  const content = await readFile(filePath, "utf8");
  return content
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return validateNexusEvent(JSON.parse(line) as unknown);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid JSONL event at ${filePath}:${index + 1}: ${message}`);
      }
    });
}

async function acquireLock(
  lockPath: string,
  timeoutMs: number
): Promise<Awaited<ReturnType<typeof open>>> {
  const started = Date.now();
  while (true) {
    const lockMetadata = await lstat(lockPath).catch(() => undefined);
    if (lockMetadata?.isSymbolicLink()) {
      throw new Error("Event log lock path must not be a symlink.");
    }
    try {
      return await open(lockPath, "wx");
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "EEXIST") {
        throw error;
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error(`Timed out waiting for event log lock: ${lockPath}`);
      }
      await delay(10);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function isInside(target: string, root: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

export function validateNexusEvent(value: unknown): NexusEvent {
  if (!isRecord(value)) {
    throw new Error("Event must be an object.");
  }
  if (value.schemaVersion !== 1) {
    throw new Error("Event schemaVersion must be 1.");
  }
  if (typeof value.id !== "string" || value.id.length === 0) {
    throw new Error("Event id is required.");
  }
  if (typeof value.sessionId !== "string" || value.sessionId.length === 0) {
    throw new Error("Event sessionId is required.");
  }
  if (typeof value.timestamp !== "string" || Number.isNaN(Date.parse(value.timestamp))) {
    throw new Error("Event timestamp must be an ISO timestamp.");
  }
  if (!nexusEventTypes.has(value.type as NexusEventType)) {
    throw new Error(`Event type '${String(value.type)}' is not registered.`);
  }
  if (
    value.severity !== undefined &&
    value.severity !== "debug" &&
    value.severity !== "info" &&
    value.severity !== "warning" &&
    value.severity !== "error"
  ) {
    throw new Error("Event severity is invalid.");
  }
  return value as NexusEvent;
}

const nexusEventTypes = new Set<NexusEventType>([
  "session.started",
  "session.completed",
  "user.input",
  "assistant.message",
  "assistant.delta",
  "model.call.started",
  "model.call.completed",
  "model.call.failed",
  "model.stream.started",
  "model.stream.delta",
  "model.stream.completed",
  "model.usage",
  "agent.step.started",
  "agent.step.completed",
  "agent.step.blocked",
  "agent.loop.completed",
  "agent.critic.completed",
  "plan.updated",
  "sdlc.goal.updated",
  "sdlc.definition_of_done.updated",
  "sdlc.stage.started",
  "sdlc.stage.completed",
  "sdlc.stage.blocked",
  "tool.requested",
  "tool.risk",
  "tool.completed",
  "approval.requested",
  "approval.granted",
  "approval.denied",
  "approval.required",
  "sandbox.unavailable",
  "sandbox.denied",
  "policy.denied",
  "file.read",
  "file.changed",
  "checkpoint.created",
  "rollback.started",
  "rollback.completed",
  "rollback.refused",
  "patch.applied",
  "shell.started",
  "shell.output",
  "shell.completed",
  "git.status",
  "git.diff",
  "git.log",
  "search.completed",
  "verification.completed",
  "review.completed",
  "ship.completed",
  "learning.candidate.created",
  "learning.candidate.accepted",
  "learning.candidate.rejected",
  "memory.written",
  "memory.updated",
  "memory.deleted",
  "eval.started",
  "eval.completed",
  "mcp.tool.started",
  "mcp.tool.completed",
  "subagent.started",
  "subagent.completed",
  "plan.approval.requested",
  "plan.approval.completed",
  "audit.recorded",
  "hook.started",
  "hook.completed",
  "error"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
