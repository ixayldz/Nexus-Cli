import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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
  public constructor(private readonly filePath: string) {}

  public async write(event: NexusEvent): Promise<void> {
    validateNexusEvent(event);
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${safeJsonStringify(event)}\n`, { flag: "a" });
  }
}

export async function readJsonlEvents(filePath: string): Promise<NexusEvent[]> {
  const content = await readFile(filePath, "utf8");
  return content
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => validateNexusEvent(JSON.parse(line) as unknown));
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
