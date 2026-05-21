import { lstat, readFile, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { createEvent } from "@nexus/events";
import { type SessionId } from "@nexus/shared";
import { type ToolBus, type ToolExecutionContext, createToolRequest } from "@nexus/tool-bus";

export type HookPoint =
  | "before_session_start"
  | "after_session_start"
  | "before_plan"
  | "after_plan"
  | "before_tool_call"
  | "after_tool_call"
  | "before_verify"
  | "after_verify"
  | "before_review"
  | "after_review"
  | "before_memory_write"
  | "after_memory_write"
  | "before_session_end"
  | "after_session_end";

export interface HookDefinition {
  id: string;
  event: HookPoint;
  command: string;
  enabled: boolean;
  requiredPermissions: string[];
  required?: boolean;
}

export class HookRegistry {
  public async list(cwd: string): Promise<HookDefinition[]> {
    await assertSafeNexusRoot(cwd);
    const content = await readFile(join(cwd, ".nexus", "hooks.json"), "utf8").catch(() => undefined);
    if (!content) {
      return [];
    }
    const parsed = JSON.parse(content) as { hooks?: unknown };
    return Array.isArray(parsed.hooks) ? parsed.hooks.filter(isHook) : [];
  }
}

export class HookRunner {
  public constructor(private readonly registry = new HookRegistry()) {}

  public async run(input: {
    cwd: string;
    sessionId: SessionId;
    point: HookPoint;
    tools: ToolBus;
    ctx: ToolExecutionContext;
  }): Promise<number> {
    if (!input.ctx.config.features.hooks) {
      return 0;
    }
    const hooks = (await this.registry.list(input.cwd)).filter((hook) => hook.enabled && hook.event === input.point);
    for (const hook of hooks) {
      const missingPermission = hook.requiredPermissions.find((permission) => !isPermissionAllowed(permission, input.ctx));
      if (missingPermission) {
        await input.ctx.eventBus.publish(
          createEvent({
            sessionId: input.sessionId,
            type: "audit.recorded",
            severity: hook.required === true ? "warning" : "info",
            data: {
              hookId: hook.id,
              point: hook.event,
              decision: hook.required === true ? "deny" : "skip",
              reason: `Hook permission '${missingPermission}' is not allowed by policy.`
            }
          })
        );
        if (hook.required === true) {
          throw new Error(`Required hook '${hook.id}' is missing permission '${missingPermission}'.`);
        }
        continue;
      }
      await input.ctx.eventBus.publish(
        createEvent({
          sessionId: input.sessionId,
          type: "hook.started",
          data: { hookId: hook.id, point: hook.event }
        })
      );
      const result = await input.tools.execute(
        createToolRequest({
          toolName: "shell.run",
          input: { command: hook.command },
          source: "hook",
          reason: `hook:${hook.id}`
        }),
        input.ctx
      );
      await input.ctx.eventBus.publish(
        createEvent({
          sessionId: input.sessionId,
          type: "hook.completed",
          data: { hookId: hook.id, point: hook.event, status: result.status }
        })
      );
      if (hook.required === true && result.status !== "success") {
        throw new Error(`Required hook '${hook.id}' failed at ${hook.event}.`);
      }
    }
    return hooks.length;
  }
}

function isPermissionAllowed(permission: string, ctx: ToolExecutionContext): boolean {
  if (permission === "workspace.read") {
    return true;
  }
  if (permission === "workspace.write") {
    return ctx.config.sandboxMode !== "read-only";
  }
  if (permission === "shell.run") {
    return ctx.config.approvalPolicy !== "never";
  }
  if (permission === "network.access") {
    return ctx.config.security.networkDefault !== "off";
  }
  return false;
}

function isHook(value: unknown): value is HookDefinition {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const item = value as Partial<HookDefinition>;
  return (
    typeof item.id === "string" &&
    typeof item.command === "string" &&
    typeof item.enabled === "boolean" &&
    isHookPoint(item.event) &&
    Array.isArray(item.requiredPermissions) &&
    (item.required === undefined || typeof item.required === "boolean")
  );
}

function isHookPoint(value: unknown): value is HookPoint {
  return typeof value === "string" && hookPoints.includes(value as HookPoint);
}

const hookPoints: HookPoint[] = [
  "before_session_start",
  "after_session_start",
  "before_plan",
  "after_plan",
  "before_tool_call",
  "after_tool_call",
  "before_verify",
  "after_verify",
  "before_review",
  "after_review",
  "before_memory_write",
  "after_memory_write",
  "before_session_end",
  "after_session_end"
];

async function assertSafeNexusRoot(cwd: string): Promise<void> {
  const workspaceRoot = resolve(cwd);
  const realWorkspaceRoot = await realpath(workspaceRoot).catch(() => workspaceRoot);
  const nexusRoot = join(workspaceRoot, ".nexus");
  const metadata = await lstat(nexusRoot).catch(() => undefined);
  if (!metadata) {
    return;
  }
  if (metadata.isSymbolicLink()) {
    throw new Error(".nexus hook registry must not be a symlink.");
  }
  const realNexusRoot = await realpath(nexusRoot).catch(() => nexusRoot);
  if (!isInside(realNexusRoot, realWorkspaceRoot)) {
    throw new Error(".nexus hook registry resolves outside the workspace.");
  }
}

function isInside(target: string, root: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}
