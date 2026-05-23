import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { type ResolvedConfig } from "@nexus/config";
import { type EventBus, createEvent } from "@nexus/events";
import {
  type ApprovalCoordinator,
  type SecurityRuntime,
  classifyCommandRisk
} from "@nexus/security";
import { type SandboxContext, type SandboxManager } from "@nexus/sandbox";
import {
  type RiskLevel,
  type SessionId,
  type ToolCallId,
  createId,
  nowIso,
  redactString,
  safeJsonStringify
} from "@nexus/shared";

export interface ToolRequest {
  id: ToolCallId;
  toolName: string;
  input: unknown;
  source: "model" | "user" | "hook" | "sdlc" | "system";
  reason?: string;
}

export interface ToolResult {
  id: ToolCallId;
  toolName: string;
  status: "success" | "failed" | "denied" | "cancelled";
  output?: unknown;
  error?: {
    message: string;
    category: "validation" | "security" | "execution";
  };
  summary?: string;
  filesChanged: string[];
  commandsRun: string[];
  exitCodeHint?: number;
}

export interface ToolExecutionContext {
  sessionId: SessionId;
  cwd: string;
  runDirectory: string;
  config: ResolvedConfig;
  eventBus: EventBus;
  security: SecurityRuntime;
  approvals?: ApprovalCoordinator;
  sandbox?: SandboxManager;
  sandboxContext?: SandboxContext;
  nonInteractive: boolean;
  approvalGranted?: boolean;
  planApproved?: boolean;
}

export interface FileCheckpoint {
  id: string;
  sessionId: SessionId;
  filePath: string;
  absolutePath: string;
  beforeHash: string | null;
  beforeContent: string | null;
  createdAt: string;
  toolCallId?: ToolCallId;
}

export interface RollbackResult {
  status: "restored" | "refused" | "not_found";
  checkpointId: string;
  restoredFiles: string[];
  refusedReason?: string;
}

export interface NexusTool<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  classifyRisk(input: TInput, ctx: ToolExecutionContext): Promise<RiskLevel>;
  prepare(input: TInput, ctx: ToolExecutionContext): Promise<void>;
  execute(input: TInput, ctx: ToolExecutionContext): Promise<TOutput>;
  summarize(output: TOutput, ctx: ToolExecutionContext): Promise<ToolSummary>;
}

export interface ToolSummary {
  summary: string;
  filesChanged?: string[];
  commandsRun?: string[];
}

export interface NexusToolMetadata {
  name: string;
  description: string;
}

export class ToolRegistry {
  private readonly tools = new Map<string, NexusTool>();

  public register(tool: NexusTool): void {
    this.tools.set(tool.name, tool);
  }

  public get(name: string): NexusTool | undefined {
    return this.tools.get(name);
  }

  public list(): NexusToolMetadata[] {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description
    }));
  }
}

export class ToolBus {
  public constructor(private readonly registry: ToolRegistry) {}

  public async execute(request: ToolRequest, ctx: ToolExecutionContext): Promise<ToolResult> {
    await ctx.eventBus.publish(
      createEvent({
        sessionId: ctx.sessionId,
        type: "tool.requested",
        data: {
          tool: request.toolName,
          source: request.source,
          reason: request.reason ?? ""
        }
      })
    );

    const tool = this.registry.get(request.toolName);
    if (!tool) {
      return this.completeFailed(
        request,
        ctx,
        "validation",
        `Tool '${request.toolName}' is not registered.`
      );
    }

    const parsedInput = tool.inputSchema.safeParse(request.input);
    if (!parsedInput.success) {
      return this.completeFailed(request, ctx, "validation", parsedInput.error.message);
    }

    const risk = await tool.classifyRisk(parsedInput.data, ctx);
    await ctx.eventBus.publish(
      createEvent({
        sessionId: ctx.sessionId,
        type: "tool.risk",
        data: {
          tool: request.toolName,
          risk
        }
      })
    );

    const policy = await ctx.security.evaluateToolRequest({
      toolName: request.toolName,
      input: parsedInput.data,
      cwd: ctx.cwd,
      config: ctx.config,
      nonInteractive: ctx.nonInteractive,
      risk
    });

    if (ctx.config.telemetry.enterpriseAudit) {
      await ctx.eventBus.publish(
        createEvent({
          sessionId: ctx.sessionId,
          type: "audit.recorded",
          data: {
            tool: request.toolName,
            source: request.source,
            risk,
            decision: policy.decision,
            reason: policy.reason
          }
        })
      );
    }

    if (policy.decision === "deny") {
      await ctx.eventBus.publish(
        createEvent({
          sessionId: ctx.sessionId,
          type: "policy.denied",
          severity: "warning",
          data: {
            tool: request.toolName,
            risk: policy.risk,
            reason: policy.reason
          }
        })
      );
      return this.completeDenied(
        request,
        ctx,
        policy.reason,
        policy.reason.includes("sandbox") ? 3 : 5
      );
    }

    if (requiresPlanBeforeMutation(request, ctx)) {
      await ctx.eventBus.publish(
        createEvent({
          sessionId: ctx.sessionId,
          type: "policy.denied",
          severity: "warning",
          data: {
            tool: request.toolName,
            risk,
            reason: "Agent mutation requires a recorded implementation plan before execution."
          }
        })
      );
      return this.completeDenied(
        request,
        ctx,
        "Agent mutation requires a recorded implementation plan before execution.",
        5
      );
    }

    let executionCtx = ctx;
    if (policy.decision === "needs_approval") {
      const fingerprint = approvalFingerprint(request.toolName, parsedInput.data, policy.risk);
      if (ctx.approvals?.hasSessionGrant(ctx.sessionId, fingerprint)) {
        await ctx.eventBus.publish(
          createEvent({
            sessionId: ctx.sessionId,
            type: "approval.granted",
            data: {
              tool: request.toolName,
              reason: "Session approval grant matched this request.",
              scope: "session"
            }
          })
        );
        executionCtx = { ...ctx, approvalGranted: true };
      } else {
        const approval = ctx.approvals?.request({
          sessionId: ctx.sessionId,
          toolName: request.toolName,
          risk: policy.risk,
          reason: policy.reason,
          fingerprint
        });
        await ctx.eventBus.publish(
          createEvent({
            sessionId: ctx.sessionId,
            type: "approval.requested",
            severity: "warning",
            data: {
              requestId: approval?.id ?? "",
              tool: request.toolName,
              risk: policy.risk,
              reason: policy.reason,
              target: summarizeApprovalTarget(request.toolName, parsedInput.data),
              sandbox: ctx.config.sandboxMode
            }
          })
        );
        await ctx.eventBus.publish(
          createEvent({
            sessionId: ctx.sessionId,
            type: "approval.required",
            severity: "warning",
            data: {
              requestId: approval?.id ?? "",
              tool: request.toolName,
              risk: policy.risk,
              reason: policy.reason,
              target: summarizeApprovalTarget(request.toolName, parsedInput.data),
              sandbox: ctx.config.sandboxMode
            }
          })
        );
        if (ctx.nonInteractive || !approval || !ctx.approvals) {
          await ctx.eventBus.publish(
            createEvent({
              sessionId: ctx.sessionId,
              type: "approval.denied",
              severity: "warning",
              data: {
                requestId: approval?.id ?? "",
                tool: request.toolName,
                reason: "Approval is unavailable in non-interactive mode."
              }
            })
          );
          return this.completeDenied(request, ctx, policy.reason, 2);
        }

        const outcome = await ctx.approvals.waitForDecision(approval.id);
        if (outcome.decision === "denied") {
          await ctx.eventBus.publish(
            createEvent({
              sessionId: ctx.sessionId,
              type: "approval.denied",
              severity: "warning",
              data: {
                requestId: approval.id,
                tool: request.toolName,
                reason: policy.reason
              }
            })
          );
          return this.completeDenied(request, ctx, policy.reason, 2);
        }

        await ctx.eventBus.publish(
          createEvent({
            sessionId: ctx.sessionId,
            type: "approval.granted",
            data: {
              requestId: approval.id,
              tool: request.toolName,
              reason: policy.reason,
              scope: outcome.decision === "approved_for_session" ? "session" : "once"
            }
          })
        );
        executionCtx = { ...ctx, approvalGranted: true };
      }
    }

    const sandbox = await executionCtx.sandbox?.prepare({
      mode: executionCtx.config.sandboxMode,
      platform: process.platform,
      requiresHardSandbox: executionCtx.config.security.requireHardSandbox,
      cwd: executionCtx.cwd,
      config: {
        preferredAdapter: executionCtx.config.sandbox.preferredAdapter,
        container: {
          runtime: executionCtx.config.sandbox.containerRuntime,
          image: executionCtx.config.sandbox.containerImage,
          network: executionCtx.config.sandbox.containerNetwork,
          envAllowlist: executionCtx.config.sandbox.envAllowlist,
          timeoutMs: executionCtx.config.sandbox.timeoutMs,
          ...(executionCtx.config.sandbox.memoryLimitMb !== undefined
            ? { memoryLimitMb: executionCtx.config.sandbox.memoryLimitMb }
            : {}),
          ...(executionCtx.config.sandbox.cpuLimit !== undefined
            ? { cpuLimit: executionCtx.config.sandbox.cpuLimit }
            : {})
        }
      }
    });
    if (sandbox && !sandbox.ok) {
      if (executionCtx.config.security.requireHardSandbox) {
        await executionCtx.eventBus.publish(
          createEvent({
            sessionId: executionCtx.sessionId,
            type: "sandbox.unavailable",
            severity: "warning",
            data: {
              tool: request.toolName,
              reason: sandbox.reason ?? "Sandbox unavailable."
            }
          })
        );
      }
      await executionCtx.eventBus.publish(
        createEvent({
          sessionId: executionCtx.sessionId,
          type: "sandbox.denied",
          severity: "warning",
          data: {
            tool: request.toolName,
            reason: sandbox.reason ?? "Sandbox unavailable."
          }
        })
      );
      return this.completeDenied(
        request,
        executionCtx,
        sandbox.reason ?? "Sandbox unavailable.",
        3
      );
    }
    if (sandbox?.context) {
      executionCtx = { ...executionCtx, sandboxContext: sandbox.context };
    }

    try {
      await tool.prepare(parsedInput.data, executionCtx);
      const output = await tool.execute(parsedInput.data, executionCtx);
      const summary = await tool.summarize(output, executionCtx);
      const result: ToolResult = {
        id: request.id,
        toolName: request.toolName,
        status: "success",
        output,
        summary: summary.summary,
        filesChanged: summary.filesChanged ?? [],
        commandsRun: summary.commandsRun ?? []
      };
      await executionCtx.eventBus.publish(
        createEvent({
          sessionId: executionCtx.sessionId,
          type: "tool.completed",
          data: {
            tool: request.toolName,
            status: result.status,
            summary: result.summary ?? ""
          }
        })
      );
      return result;
    } catch (error) {
      return this.completeFailed(
        request,
        executionCtx,
        "execution",
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  private async completeDenied(
    request: ToolRequest,
    ctx: ToolExecutionContext,
    reason: string,
    exitCodeHint: number
  ): Promise<ToolResult> {
    const result: ToolResult = {
      id: request.id,
      toolName: request.toolName,
      status: "denied",
      error: { category: "security", message: reason },
      summary: reason,
      filesChanged: [],
      commandsRun: [],
      exitCodeHint
    };
    await ctx.eventBus.publish(
      createEvent({
        sessionId: ctx.sessionId,
        type: "tool.completed",
        data: {
          tool: request.toolName,
          status: result.status,
          summary: reason
        }
      })
    );
    return result;
  }

  private async completeFailed(
    request: ToolRequest,
    ctx: ToolExecutionContext,
    category: "validation" | "execution",
    message: string
  ): Promise<ToolResult> {
    const result: ToolResult = {
      id: request.id,
      toolName: request.toolName,
      status: "failed",
      error: { category, message },
      summary: message,
      filesChanged: [],
      commandsRun: [],
      exitCodeHint: 5
    };
    await ctx.eventBus.publish(
      createEvent({
        sessionId: ctx.sessionId,
        type: "tool.completed",
        severity: "error",
        data: {
          tool: request.toolName,
          status: result.status,
          summary: message
        }
      })
    );
    return result;
  }
}

function requiresPlanBeforeMutation(request: ToolRequest, ctx: ToolExecutionContext): boolean {
  return (
    request.source === "model" &&
    ctx.config.sdlc.requirePlanForLargeChanges &&
    ctx.planApproved !== true &&
    (request.toolName === "file.write" || request.toolName === "patch.apply")
  );
}

export class RollbackManager {
  public async rollback(input: {
    checkpointId: string;
    ctx: ToolExecutionContext;
  }): Promise<RollbackResult> {
    await input.ctx.eventBus.publish(
      createEvent({
        sessionId: input.ctx.sessionId,
        type: "rollback.started",
        data: { checkpointId: input.checkpointId }
      })
    );

    const checkpoint = await readCheckpoint(input.ctx.runDirectory, input.checkpointId);
    if (!checkpoint) {
      const result: RollbackResult = {
        status: "not_found",
        checkpointId: input.checkpointId,
        restoredFiles: [],
        refusedReason: "Checkpoint was not found."
      };
      await publishRollbackRefused(input.ctx, result);
      return result;
    }

    const guarded = await input.ctx.security.guardPath({
      cwd: input.ctx.cwd,
      path: checkpoint.filePath,
      config: input.ctx.config,
      operation: "write"
    });
    if (!guarded.allowed) {
      const result: RollbackResult = {
        status: "refused",
        checkpointId: checkpoint.id,
        restoredFiles: [],
        refusedReason: guarded.reason ?? "Rollback target was denied by policy."
      };
      await publishRollbackRefused(input.ctx, result);
      return result;
    }

    if (checkpoint.beforeContent === null) {
      await unlink(guarded.absolutePath).catch(() => undefined);
    } else {
      await mkdir(dirname(guarded.absolutePath), { recursive: true });
      await writeFile(guarded.absolutePath, checkpoint.beforeContent, "utf8");
    }

    const result: RollbackResult = {
      status: "restored",
      checkpointId: checkpoint.id,
      restoredFiles: [guarded.relativePath]
    };
    await input.ctx.eventBus.publish(
      createEvent({
        sessionId: input.ctx.sessionId,
        type: "rollback.completed",
        data: { ...result }
      })
    );
    return result;
  }
}

const fileReadInputSchema = z.object({ path: z.string().min(1) });
const fileWriteInputSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  createDirs: z.boolean().optional()
});
const patchApplyInputSchema = z.object({
  patch: z.string().min(1),
  dryRun: z.boolean().optional()
});
const shellRunInputSchema = z.object({
  command: z.string().min(1),
  timeoutMs: z.number().int().positive().max(300000).optional(),
  maxOutputBytes: z
    .number()
    .int()
    .positive()
    .max(10 * 1024 * 1024)
    .optional()
});
const gitLogInputSchema = z
  .object({ maxCount: z.number().int().positive().max(100).optional() })
  .optional();
const testRunInputSchema = shellRunInputSchema;
const searchFilesInputSchema = z.object({
  query: z.string().min(1),
  maxResults: z.number().int().positive().max(1000).optional()
});
const mcpCallInputSchema = z.object({
  serverId: z.string().min(1),
  toolName: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).optional()
});

export class FileReadTool implements NexusTool<
  z.infer<typeof fileReadInputSchema>,
  FileReadOutput
> {
  public readonly name = "file.read";
  public readonly description = "Read a UTF-8 file from the current workspace.";
  public readonly inputSchema = fileReadInputSchema;

  public async classifyRisk(): Promise<RiskLevel> {
    return "low";
  }

  public async prepare(): Promise<void> {}

  public async execute(
    input: z.infer<typeof fileReadInputSchema>,
    ctx: ToolExecutionContext
  ): Promise<FileReadOutput> {
    const guarded = await ctx.security.guardPath({
      cwd: ctx.cwd,
      path: input.path,
      config: ctx.config,
      operation: "read",
      allowProtected: ctx.approvalGranted === true
    });
    if (!guarded.allowed) {
      throw new Error(guarded.reason ?? "Path denied by policy.");
    }

    const metadata = await stat(guarded.absolutePath);
    if (!metadata.isFile()) {
      throw new Error(`Path '${input.path}' is not a file.`);
    }
    if (metadata.size > 1024 * 1024) {
      throw new Error(`Path '${input.path}' is too large to read.`);
    }

    const buffer = await readFile(guarded.absolutePath);
    if (buffer.includes(0)) {
      throw new Error(`Path '${input.path}' appears to be binary.`);
    }

    const output = {
      path: guarded.relativePath,
      absolutePath: guarded.absolutePath,
      content: redactString(buffer.toString("utf8")),
      size: metadata.size,
      encoding: "utf8"
    } satisfies FileReadOutput;

    await ctx.eventBus.publish(
      createEvent({
        sessionId: ctx.sessionId,
        type: "file.read",
        data: { path: output.path, size: output.size }
      })
    );

    return output;
  }

  public async summarize(output: FileReadOutput): Promise<ToolSummary> {
    return { summary: `Read ${output.path} (${output.size} bytes).` };
  }
}

export interface FileReadOutput {
  path: string;
  absolutePath: string;
  content: string;
  size: number;
  encoding: "utf8";
}

export class FileWriteTool implements NexusTool<
  z.infer<typeof fileWriteInputSchema>,
  FileWriteOutput
> {
  public readonly name = "file.write";
  public readonly description = "Write a UTF-8 file inside the workspace.";
  public readonly inputSchema = fileWriteInputSchema;

  public async classifyRisk(): Promise<RiskLevel> {
    return "medium";
  }

  public async prepare(
    input: z.infer<typeof fileWriteInputSchema>,
    ctx: ToolExecutionContext
  ): Promise<void> {
    const guarded = await ctx.security.guardPath({
      cwd: ctx.cwd,
      path: input.path,
      config: ctx.config,
      operation: "write",
      allowProtected: ctx.approvalGranted === true
    });
    if (!guarded.allowed) {
      throw new Error(guarded.reason ?? "Path denied by policy.");
    }
  }

  public async execute(
    input: z.infer<typeof fileWriteInputSchema>,
    ctx: ToolExecutionContext
  ): Promise<FileWriteOutput> {
    const guarded = await ctx.security.guardPath({
      cwd: ctx.cwd,
      path: input.path,
      config: ctx.config,
      operation: "write",
      allowProtected: ctx.approvalGranted === true
    });
    if (!guarded.allowed) {
      throw new Error(guarded.reason ?? "Path denied by policy.");
    }

    const beforeContent = await readFile(guarded.absolutePath, "utf8").catch(() => undefined);
    if (beforeContent === undefined && !input.createDirs) {
      await stat(dirname(guarded.absolutePath));
    }
    if (input.createDirs) {
      await mkdir(dirname(guarded.absolutePath), { recursive: true });
    }

    const checkpoint = await createCheckpoint({
      ctx,
      filePath: guarded.relativePath,
      absolutePath: guarded.absolutePath,
      beforeContent
    });
    await writeFile(guarded.absolutePath, input.content, "utf8");
    const diff = redactString(
      createUnifiedDiff(guarded.relativePath, beforeContent ?? "", input.content)
    );

    await ctx.eventBus.publish(
      createEvent({
        sessionId: ctx.sessionId,
        type: "file.changed",
        data: { path: guarded.relativePath, checkpointId: checkpoint.id, diff }
      })
    );

    return {
      path: guarded.relativePath,
      checkpointId: checkpoint.id,
      diff,
      bytesWritten: Buffer.byteLength(input.content, "utf8")
    };
  }

  public async summarize(output: FileWriteOutput): Promise<ToolSummary> {
    return {
      summary: `Wrote ${output.path} (${output.bytesWritten} bytes).`,
      filesChanged: [output.path]
    };
  }
}

export interface FileWriteOutput {
  path: string;
  checkpointId: string;
  diff: string;
  bytesWritten: number;
}

export class PatchApplyTool implements NexusTool<
  z.infer<typeof patchApplyInputSchema>,
  PatchApplyOutput
> {
  public readonly name = "patch.apply";
  public readonly description = "Apply a unified diff inside the workspace.";
  public readonly inputSchema = patchApplyInputSchema;

  public async classifyRisk(): Promise<RiskLevel> {
    return "medium";
  }

  public async prepare(input: z.infer<typeof patchApplyInputSchema>): Promise<void> {
    parseUnifiedPatch(input.patch);
  }

  public async execute(
    input: z.infer<typeof patchApplyInputSchema>,
    ctx: ToolExecutionContext
  ): Promise<PatchApplyOutput> {
    const filePatches = parseUnifiedPatch(input.patch);
    const changedFiles: string[] = [];
    const checkpoints: string[] = [];
    const diff = redactString(input.patch);

    for (const patch of filePatches) {
      const guarded = await ctx.security.guardPath({
        cwd: ctx.cwd,
        path: patch.path,
        config: ctx.config,
        operation: "write",
        allowProtected: ctx.approvalGranted === true
      });
      if (!guarded.allowed) {
        throw new Error(guarded.reason ?? "Path denied by policy.");
      }

      const beforeContent = await readFile(guarded.absolutePath, "utf8").catch(() => "");
      const afterContent = applyFilePatch(beforeContent, patch);
      if (!input.dryRun) {
        await mkdir(dirname(guarded.absolutePath), { recursive: true });
        const checkpoint = await createCheckpoint({
          ctx,
          filePath: guarded.relativePath,
          absolutePath: guarded.absolutePath,
          beforeContent
        });
        checkpoints.push(checkpoint.id);
        await writeFile(guarded.absolutePath, afterContent, "utf8");
        await ctx.eventBus.publish(
          createEvent({
            sessionId: ctx.sessionId,
            type: "file.changed",
            data: { path: guarded.relativePath, checkpointId: checkpoint.id, diff }
          })
        );
      }
      changedFiles.push(guarded.relativePath);
    }

    await ctx.eventBus.publish(
      createEvent({
        sessionId: ctx.sessionId,
        type: "patch.applied",
        data: { dryRun: input.dryRun ?? false, changedFiles }
      })
    );

    return {
      dryRun: input.dryRun ?? false,
      changedFiles,
      checkpoints,
      diff
    };
  }

  public async summarize(output: PatchApplyOutput): Promise<ToolSummary> {
    return {
      summary: `${output.dryRun ? "Validated" : "Applied"} patch touching ${output.changedFiles.length} file(s).`,
      filesChanged: output.dryRun ? [] : output.changedFiles
    };
  }
}

export interface PatchApplyOutput {
  dryRun: boolean;
  changedFiles: string[];
  checkpoints: string[];
  diff: string;
}

export class ShellRunTool implements NexusTool<
  z.infer<typeof shellRunInputSchema>,
  ShellRunOutput
> {
  public readonly name = "shell.run";
  public readonly description = "Run a shell command through policy and sandbox controls.";
  public readonly inputSchema = shellRunInputSchema;

  public async classifyRisk(input: z.infer<typeof shellRunInputSchema>): Promise<RiskLevel> {
    return classifyShellRiskLocally(input.command);
  }

  public async prepare(): Promise<void> {}

  public async execute(
    input: z.infer<typeof shellRunInputSchema>,
    ctx: ToolExecutionContext
  ): Promise<ShellRunOutput> {
    return runShellCommand(input.command, ctx, {
      timeoutMs: input.timeoutMs ?? 30000,
      maxOutputBytes: input.maxOutputBytes ?? 1024 * 1024,
      emitEvents: true
    });
  }

  public async summarize(output: ShellRunOutput): Promise<ToolSummary> {
    return {
      summary: `Command exited ${output.exitCode}.`,
      commandsRun: [output.command]
    };
  }
}

export class GitStatusTool implements NexusTool<Record<string, never>, GitCommandOutput> {
  public readonly name = "git.status";
  public readonly description = "Read git branch and working tree status.";
  public readonly inputSchema = z
    .object({})
    .optional()
    .transform(() => ({}));

  public async classifyRisk(): Promise<RiskLevel> {
    return "low";
  }

  public async prepare(): Promise<void> {}

  public async execute(
    _input: Record<string, never>,
    ctx: ToolExecutionContext
  ): Promise<GitCommandOutput> {
    const result = await runFixedCommand(
      "git",
      ["status", "--short", "--branch"],
      ctx,
      "git.status"
    );
    return { ...result, command: "git status --short --branch" };
  }

  public async summarize(output: GitCommandOutput): Promise<ToolSummary> {
    return {
      summary: output.exitCode === 0 ? "Read git status." : "Git status unavailable.",
      commandsRun: [output.command]
    };
  }
}

export class GitDiffTool implements NexusTool<Record<string, never>, GitCommandOutput> {
  public readonly name = "git.diff";
  public readonly description = "Read current working tree diff.";
  public readonly inputSchema = z
    .object({})
    .optional()
    .transform(() => ({}));

  public async classifyRisk(): Promise<RiskLevel> {
    return "low";
  }

  public async prepare(): Promise<void> {}

  public async execute(
    _input: Record<string, never>,
    ctx: ToolExecutionContext
  ): Promise<GitCommandOutput> {
    const result = await runFixedCommand("git", ["diff", "--"], ctx, "git.diff");
    return { ...result, command: "git diff --" };
  }

  public async summarize(output: GitCommandOutput): Promise<ToolSummary> {
    return {
      summary: output.exitCode === 0 ? "Read git diff." : "Git diff unavailable.",
      commandsRun: [output.command]
    };
  }
}

export class GitLogTool implements NexusTool<z.infer<typeof gitLogInputSchema>, GitCommandOutput> {
  public readonly name = "git.log";
  public readonly description = "Read recent git commit log.";
  public readonly inputSchema = gitLogInputSchema.transform((value) => value ?? {});

  public async classifyRisk(): Promise<RiskLevel> {
    return "low";
  }

  public async prepare(): Promise<void> {}

  public async execute(
    input: z.infer<typeof gitLogInputSchema>,
    ctx: ToolExecutionContext
  ): Promise<GitCommandOutput> {
    const maxCount = String(input?.maxCount ?? 5);
    const result = await runFixedCommand(
      "git",
      ["log", `--max-count=${maxCount}`, "--oneline"],
      ctx,
      "git.log"
    );
    return { ...result, command: `git log --max-count=${maxCount} --oneline` };
  }

  public async summarize(output: GitCommandOutput): Promise<ToolSummary> {
    return {
      summary: output.exitCode === 0 ? "Read git log." : "Git log unavailable.",
      commandsRun: [output.command]
    };
  }
}

export interface GitCommandOutput extends ShellRunOutput {
  command: string;
}

export class TestRunTool implements NexusTool<z.infer<typeof testRunInputSchema>, TestRunOutput> {
  public readonly name = "test.run";
  public readonly description = "Run an explicit verification command.";
  public readonly inputSchema = testRunInputSchema;

  public async classifyRisk(): Promise<RiskLevel> {
    return "medium";
  }

  public async prepare(): Promise<void> {}

  public async execute(
    input: z.infer<typeof testRunInputSchema>,
    ctx: ToolExecutionContext
  ): Promise<TestRunOutput> {
    const shell = await runShellCommand(input.command, ctx, {
      timeoutMs: input.timeoutMs ?? 30000,
      maxOutputBytes: input.maxOutputBytes ?? 1024 * 1024,
      emitEvents: true
    });
    return {
      ...shell,
      status: shell.exitCode === 0 ? "passed" : "failed"
    };
  }

  public async summarize(output: TestRunOutput): Promise<ToolSummary> {
    return {
      summary: `Verification ${output.status}; command exited ${output.exitCode}.`,
      commandsRun: [output.command]
    };
  }
}

export interface TestRunOutput extends ShellRunOutput {
  status: "passed" | "failed";
}

export class SearchFilesTool implements NexusTool<
  z.infer<typeof searchFilesInputSchema>,
  SearchFilesOutput
> {
  public readonly name = "search.files";
  public readonly description = "Search text files in the workspace.";
  public readonly inputSchema = searchFilesInputSchema;

  public async classifyRisk(): Promise<RiskLevel> {
    return "low";
  }

  public async prepare(): Promise<void> {}

  public async execute(
    input: z.infer<typeof searchFilesInputSchema>,
    ctx: ToolExecutionContext
  ): Promise<SearchFilesOutput> {
    const results: SearchFileMatch[] = [];
    const maxResults = input.maxResults ?? 50;
    await searchDirectory(ctx.cwd, ctx.cwd, input.query, results, maxResults);

    await ctx.eventBus.publish(
      createEvent({
        sessionId: ctx.sessionId,
        type: "search.completed",
        data: {
          query: input.query,
          matchCount: results.length
        }
      })
    );

    return { query: input.query, matches: results };
  }

  public async summarize(output: SearchFilesOutput): Promise<ToolSummary> {
    return { summary: `Found ${output.matches.length} match(es) for '${output.query}'.` };
  }
}

export interface SearchFilesOutput {
  query: string;
  matches: SearchFileMatch[];
}

export interface SearchFileMatch {
  path: string;
  line: number;
  text: string;
}

export class McpCallTool implements NexusTool<z.infer<typeof mcpCallInputSchema>, McpCallOutput> {
  public readonly name = "mcp.call";
  public readonly description = "Call an approved MCP server tool through the local MCP runtime.";
  public readonly inputSchema = mcpCallInputSchema;

  public async classifyRisk(): Promise<RiskLevel> {
    return "medium";
  }

  public async prepare(
    input: z.infer<typeof mcpCallInputSchema>,
    ctx: ToolExecutionContext
  ): Promise<void> {
    if (!ctx.config.features.mcp) {
      throw new Error("MCP execution is disabled by feature policy.");
    }
    const server = await findMcpServer(ctx.cwd, input.serverId);
    if (!server) {
      throw new Error(`MCP server '${input.serverId}' is not configured.`);
    }
    if (!server.enabled) {
      throw new Error(`MCP server '${input.serverId}' is disabled.`);
    }
    const allowedServers = ctx.config.policy.allowedMcpServers.filter(
      (item) => item.trim().length > 0
    );
    if (allowedServers.length > 0 && !allowedServers.includes(server.id)) {
      throw new Error(`MCP server '${server.id}' is denied by policy.`);
    }
    if (server.transport !== "stdio") {
      throw new Error("Only stdio MCP servers are supported for tool execution in this build.");
    }
    if (server.trust !== "trusted") {
      throw new Error(`MCP server '${server.id}' is not trusted for execution.`);
    }
    if (
      server.allowedTools &&
      server.allowedTools.length > 0 &&
      !server.allowedTools.includes(input.toolName)
    ) {
      throw new Error(`MCP tool '${input.toolName}' is not allowlisted for server '${server.id}'.`);
    }
    if (!server.command) {
      throw new Error(`MCP server '${server.id}' is missing a command.`);
    }
  }

  public async execute(
    input: z.infer<typeof mcpCallInputSchema>,
    ctx: ToolExecutionContext
  ): Promise<McpCallOutput> {
    const server = await findMcpServer(ctx.cwd, input.serverId);
    if (!server || !server.command) {
      throw new Error(`MCP server '${input.serverId}' is not executable.`);
    }
    await ctx.eventBus.publish(
      createEvent({
        sessionId: ctx.sessionId,
        type: "mcp.tool.started",
        data: {
          serverId: server.id,
          toolName: input.toolName
        }
      })
    );
    const result = await callMcpStdioTool({
      server,
      toolName: input.toolName,
      arguments: input.arguments ?? {},
      cwd: ctx.cwd,
      timeoutMs: 30000
    });
    const output = {
      serverId: server.id,
      toolName: input.toolName,
      result
    };
    await ctx.eventBus.publish(
      createEvent({
        sessionId: ctx.sessionId,
        type: "mcp.tool.completed",
        data: {
          serverId: server.id,
          toolName: input.toolName,
          status: "success"
        }
      })
    );
    return output;
  }

  public async summarize(output: McpCallOutput): Promise<ToolSummary> {
    return { summary: `Called MCP tool ${output.serverId}/${output.toolName}.` };
  }
}

export interface McpCallOutput {
  serverId: string;
  toolName: string;
  result: unknown;
}

export interface ShellRunOutput {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

export function createDefaultToolBus(): ToolBus {
  const registry = new ToolRegistry();
  registry.register(new FileReadTool());
  registry.register(new FileWriteTool());
  registry.register(new PatchApplyTool());
  registry.register(new ShellRunTool());
  registry.register(new GitStatusTool());
  registry.register(new GitDiffTool());
  registry.register(new GitLogTool());
  registry.register(new TestRunTool());
  registry.register(new SearchFilesTool());
  registry.register(new McpCallTool());
  return new ToolBus(registry);
}

export function createToolRequest(
  input: Omit<ToolRequest, "id"> & { id?: ToolCallId }
): ToolRequest {
  return {
    id: input.id ?? (createId("tool") as unknown as ToolCallId),
    toolName: input.toolName,
    input: input.input,
    source: input.source,
    ...(input.reason ? { reason: input.reason } : {})
  };
}

function approvalFingerprint(toolName: string, input: unknown, risk: RiskLevel): string {
  return sha256(`${toolName}:${risk}:${safeJsonStringify(input)}`);
}

function summarizeApprovalTarget(toolName: string, input: unknown): string {
  if (typeof input !== "object" || input === null) {
    return toolName;
  }
  if ("command" in input && typeof input.command === "string") {
    return input.command;
  }
  if ("path" in input && typeof input.path === "string") {
    return input.path;
  }
  if ("patch" in input && typeof input.patch === "string") {
    const paths = parsePatchPathsForSummary(input.patch);
    return paths.length > 0 ? paths.join(", ") : "patch";
  }
  return toolName;
}

function parsePatchPathsForSummary(patch: string): string[] {
  return [...patch.matchAll(/^\+\+\+\s+(?:b\/)?(.+)$/gm)]
    .map((match) => match[1])
    .filter((path): path is string => Boolean(path) && path !== "/dev/null")
    .slice(0, 5);
}

async function createCheckpoint(input: {
  ctx: ToolExecutionContext;
  filePath: string;
  absolutePath: string;
  beforeContent: string | undefined;
}): Promise<{ id: string }> {
  const id = createId("checkpoint") as unknown as string;
  const content = input.beforeContent;
  const checkpoint: FileCheckpoint = {
    id,
    sessionId: input.ctx.sessionId,
    filePath: input.filePath,
    absolutePath: input.absolutePath,
    beforeHash: content === undefined ? null : sha256(content),
    beforeContent: content ?? null,
    createdAt: nowIso()
  };
  const checkpointPath = join(input.ctx.runDirectory, "checkpoints", `${id}.json`);
  await mkdir(dirname(checkpointPath), { recursive: true });
  await writeFile(checkpointPath, `${safeJsonStringify(checkpoint)}\n`, "utf8");
  await input.ctx.eventBus.publish(
    createEvent({
      sessionId: input.ctx.sessionId,
      type: "checkpoint.created",
      data: { checkpointId: id, path: input.filePath }
    })
  );
  return { id };
}

async function readCheckpoint(
  runDirectory: string,
  checkpointId: string
): Promise<FileCheckpoint | undefined> {
  const checkpointDirectory = join(runDirectory, "checkpoints");
  if (checkpointId === "latest") {
    const entries = await readdir(checkpointDirectory).catch(() => []);
    const checkpoints = (
      await Promise.all(
        entries
          .filter((entry) => entry.endsWith(".json"))
          .map((entry) => readCheckpointFile(join(checkpointDirectory, entry)))
      )
    )
      .filter((checkpoint): checkpoint is FileCheckpoint => Boolean(checkpoint))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    return checkpoints[0];
  }
  return readCheckpointFile(join(checkpointDirectory, `${checkpointId}.json`));
}

async function readCheckpointFile(filePath: string): Promise<FileCheckpoint | undefined> {
  const content = await readFile(filePath, "utf8").catch(() => undefined);
  if (!content) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(content) as Partial<FileCheckpoint>;
    if (
      typeof parsed.id === "string" &&
      typeof parsed.filePath === "string" &&
      typeof parsed.absolutePath === "string" &&
      typeof parsed.createdAt === "string"
    ) {
      return {
        id: parsed.id,
        sessionId: parsed.sessionId as SessionId,
        filePath: parsed.filePath,
        absolutePath: parsed.absolutePath,
        beforeHash: typeof parsed.beforeHash === "string" ? parsed.beforeHash : null,
        beforeContent: typeof parsed.beforeContent === "string" ? parsed.beforeContent : null,
        createdAt: parsed.createdAt,
        ...(parsed.toolCallId ? { toolCallId: parsed.toolCallId } : {})
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function publishRollbackRefused(
  ctx: ToolExecutionContext,
  result: RollbackResult
): Promise<void> {
  await ctx.eventBus.publish(
    createEvent({
      sessionId: ctx.sessionId,
      type: "rollback.refused",
      severity: "warning",
      data: { ...result }
    })
  );
}

function createUnifiedDiff(path: string, before: string, after: string): string {
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  return [`--- a/${path}`, `+++ b/${path}`, "@@ -1 +1 @@"]
    .concat(beforeLines.map((line) => `-${line}`))
    .concat(afterLines.map((line) => `+${line}`))
    .join("\n");
}

function parseUnifiedPatch(patch: string): ParsedFilePatch[] {
  const lines = patch.split(/\r?\n/);
  const patches: ParsedFilePatch[] = [];
  let current: ParsedFilePatch | undefined;

  for (const line of lines) {
    if (line.startsWith("+++ ")) {
      const path = line.slice(4).replace(/^b\//, "");
      if (path !== "/dev/null") {
        current = { path, hunks: [] };
        patches.push(current);
      }
      continue;
    }
    if (line.startsWith("@@ ")) {
      if (!current) {
        throw new Error("Patch hunk appeared before target file.");
      }
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (!match?.[1]) {
        throw new Error(`Unsupported hunk header '${line}'.`);
      }
      current.hunks.push({ oldStart: Number(match[1]), lines: [] });
      continue;
    }
    const hunk = current?.hunks.at(-1);
    if (
      hunk &&
      (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-") || line === "\\")
    ) {
      hunk.lines.push(line);
    }
  }

  if (patches.length === 0) {
    throw new Error("Patch contains no target files.");
  }
  return patches;
}

function applyFilePatch(beforeContent: string, patch: ParsedFilePatch): string {
  const original = beforeContent.length > 0 ? beforeContent.split(/\r?\n/) : [];
  const output: string[] = [];
  let originalIndex = 0;

  for (const hunk of patch.hunks) {
    const targetIndex = Math.max(0, hunk.oldStart - 1);
    while (originalIndex < targetIndex) {
      output.push(original[originalIndex] ?? "");
      originalIndex += 1;
    }

    for (const line of hunk.lines) {
      if (line.startsWith(" ")) {
        assertPatchLine(original[originalIndex], line.slice(1), patch.path, hunk.oldStart);
        output.push(line.slice(1));
        originalIndex += 1;
      } else if (line.startsWith("-")) {
        assertPatchLine(original[originalIndex], line.slice(1), patch.path, hunk.oldStart);
        originalIndex += 1;
      } else if (line.startsWith("+")) {
        output.push(line.slice(1));
      }
    }
  }

  while (originalIndex < original.length) {
    output.push(original[originalIndex] ?? "");
    originalIndex += 1;
  }

  return output.join("\n");
}

function assertPatchLine(
  actual: string | undefined,
  expected: string,
  path: string,
  hunkStart: number
): void {
  if ((actual ?? "") !== expected) {
    throw new Error(`Patch context mismatch in ${path} near original line ${hunkStart}.`);
  }
}

interface ParsedFilePatch {
  path: string;
  hunks: Array<{ oldStart: number; lines: string[] }>;
}

async function runFixedCommand(
  command: string,
  args: string[],
  ctx: ToolExecutionContext,
  eventType: "git.status" | "git.diff" | "git.log"
): Promise<ShellRunOutput> {
  const result = await runProcess(command, args, ctx, {
    timeoutMs: 30000,
    maxOutputBytes: 1024 * 1024,
    shell: false
  });
  await ctx.eventBus.publish(
    createEvent({
      sessionId: ctx.sessionId,
      type: eventType,
      data: {
        exitCode: result.exitCode,
        stdout: result.stdout,
        ...(eventType === "git.status" ? { branch: parseGitBranch(result.stdout) } : {}),
        ...(eventType === "git.diff" ? { diff: result.stdout } : {})
      }
    })
  );
  return result;
}

function parseGitBranch(stdout: string): string {
  const branchLine = stdout.split(/\r?\n/).find((line) => line.startsWith("## "));
  if (!branchLine) {
    return "unknown";
  }
  return branchLine.slice(3).split("...")[0]?.trim() || "unknown";
}

async function runShellCommand(
  command: string,
  ctx: ToolExecutionContext,
  options: { timeoutMs: number; maxOutputBytes: number; emitEvents: boolean }
): Promise<ShellRunOutput> {
  if (options.emitEvents) {
    await ctx.eventBus.publish(
      createEvent({
        sessionId: ctx.sessionId,
        type: "shell.started",
        data: { command: redactString(command) }
      })
    );
  }
  const result = await runProcess(command, [], ctx, { ...options, shell: true });
  if (options.emitEvents) {
    await ctx.eventBus.publish(
      createEvent({
        sessionId: ctx.sessionId,
        type: "shell.completed",
        data: {
          command: redactString(command),
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          truncated: result.truncated
        }
      })
    );
  }
  return result;
}

async function runProcess(
  command: string,
  args: string[],
  ctx: ToolExecutionContext,
  options: { timeoutMs: number; maxOutputBytes: number; shell: boolean }
): Promise<ShellRunOutput> {
  return new Promise((resolvePromise) => {
    const processSpec = createSandboxedProcessSpec(command, args, ctx, options.shell);
    const reportedCommand = redactString(processSpec.reportedCommand);
    const child = spawn(processSpec.command, processSpec.args, {
      cwd: processSpec.cwd,
      shell: processSpec.shell,
      env: sanitizeEnv(
        process.env,
        ctx.sandboxContext?.hardEnforced ? ctx.sandboxContext.envAllowlist : undefined
      ),
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    const outputEvents: Array<Promise<void>> = [];
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      const next = redactString(chunk.toString("utf8"));
      outputEvents.push(
        ctx.eventBus.publish(
          createEvent({
            sessionId: ctx.sessionId,
            type: "shell.output",
            data: { stream: "stdout", text: next }
          })
        )
      );
      const remaining = options.maxOutputBytes - Buffer.byteLength(stdout, "utf8");
      if (remaining > 0) {
        stdout += next.slice(0, remaining);
      }
      truncated = truncated || Buffer.byteLength(next, "utf8") > remaining;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const next = redactString(chunk.toString("utf8"));
      outputEvents.push(
        ctx.eventBus.publish(
          createEvent({
            sessionId: ctx.sessionId,
            type: "shell.output",
            data: { stream: "stderr", text: next }
          })
        )
      );
      const remaining = options.maxOutputBytes - Buffer.byteLength(stderr, "utf8");
      if (remaining > 0) {
        stderr += next.slice(0, remaining);
      }
      truncated = truncated || Buffer.byteLength(next, "utf8") > remaining;
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      void Promise.all(outputEvents).then(() => {
        resolvePromise({
          command: reportedCommand,
          exitCode,
          stdout,
          stderr,
          timedOut,
          truncated
        });
      });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      void Promise.all(outputEvents).then(() => {
        resolvePromise({
          command: reportedCommand,
          exitCode: null,
          stdout,
          stderr: redactString(error.message),
          timedOut,
          truncated
        });
      });
    });
  });
}

function createSandboxedProcessSpec(
  command: string,
  args: string[],
  ctx: ToolExecutionContext,
  shell: boolean
): { command: string; args: string[]; shell: boolean; cwd: string; reportedCommand: string } {
  const originalCommand = shell ? command : quoteShellArgs([command, ...args]);
  const sandbox = ctx.sandboxContext;
  if (!sandbox?.hardEnforced || !sandbox.runtime || sandbox.runtime === "typescript") {
    return {
      command,
      args,
      shell,
      cwd: ctx.cwd,
      reportedCommand: shell ? command : [command, ...args].join(" ")
    };
  }

  const mountMode = sandbox.mountMode === "read-only" ? "ro" : "rw";
  const runArgs = [
    "run",
    "--rm",
    "--network",
    sandbox.network ?? "none",
    "-v",
    `${sandbox.workspacePath ?? ctx.cwd}:/workspace:${mountMode}`,
    "-w",
    "/workspace"
  ];
  if (sandbox.memoryLimitMb !== undefined) {
    runArgs.push("--memory", `${sandbox.memoryLimitMb}m`);
  }
  if (sandbox.cpuLimit !== undefined) {
    runArgs.push("--cpus", String(sandbox.cpuLimit));
  }
  for (const key of sandbox.envAllowlist ?? []) {
    if (process.env[key]) {
      runArgs.push("-e", key);
    }
  }
  runArgs.push(sandbox.image ?? "node:22-bookworm-slim", "sh", "-lc", originalCommand);

  return {
    command: sandbox.runtime,
    args: runArgs,
    shell: false,
    cwd: ctx.cwd,
    reportedCommand: originalCommand
  };
}

function quoteShellArgs(values: string[]): string {
  return values.map(quoteForSh).join(" ");
}

function quoteForSh(value: string): string {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

interface StoredMcpServer {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  enabled: boolean;
  permissions: string[];
  trust?: "untrusted" | "trusted";
  allowedTools?: string[];
  envAllowlist?: string[];
  pinnedCommandSha256?: string;
}

async function findMcpServer(cwd: string, serverId: string): Promise<StoredMcpServer | undefined> {
  await assertSafeNexusRoot(cwd);
  const content = await readFile(join(cwd, ".nexus", "mcp.json"), "utf8").catch(() => undefined);
  if (!content) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(content) as { servers?: unknown };
    const servers = Array.isArray(parsed.servers) ? parsed.servers.filter(isStoredMcpServer) : [];
    return servers.find((server) => server.id === serverId);
  } catch {
    return undefined;
  }
}

async function assertSafeNexusRoot(cwd: string): Promise<void> {
  const workspaceRoot = resolve(cwd);
  const realWorkspaceRoot = await realpath(workspaceRoot).catch(() => workspaceRoot);
  const nexusRoot = join(workspaceRoot, ".nexus");
  const metadata = await lstat(nexusRoot).catch(() => undefined);
  if (!metadata) {
    return;
  }
  if (metadata.isSymbolicLink()) {
    throw new Error(".nexus MCP registry must not be a symlink.");
  }
  const realNexusRoot = await realpath(nexusRoot).catch(() => nexusRoot);
  if (!isInside(realNexusRoot, realWorkspaceRoot)) {
    throw new Error(".nexus MCP registry resolves outside the workspace.");
  }
}

function isInside(target: string, root: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function isStoredMcpServer(value: unknown): value is StoredMcpServer {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const item = value as Partial<StoredMcpServer>;
  return (
    typeof item.id === "string" &&
    typeof item.name === "string" &&
    (item.transport === "stdio" || item.transport === "http") &&
    typeof item.enabled === "boolean" &&
    Array.isArray(item.permissions) &&
    (item.trust === undefined || item.trust === "untrusted" || item.trust === "trusted") &&
    (item.allowedTools === undefined ||
      item.allowedTools.every((tool) => typeof tool === "string")) &&
    (item.envAllowlist === undefined ||
      item.envAllowlist.every((key) => typeof key === "string")) &&
    (item.pinnedCommandSha256 === undefined || typeof item.pinnedCommandSha256 === "string") &&
    (item.command === undefined || typeof item.command === "string") &&
    (item.args === undefined || item.args.every((arg) => typeof arg === "string")) &&
    (item.url === undefined || typeof item.url === "string")
  );
}

async function callMcpStdioTool(input: {
  server: StoredMcpServer;
  toolName: string;
  arguments: Record<string, unknown>;
  cwd: string;
  timeoutMs: number;
}): Promise<unknown> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(input.server.command ?? "", input.server.args ?? [], {
      cwd: input.cwd,
      shell: false,
      env: sanitizeEnv(process.env, input.server.envAllowlist ?? []),
      windowsHide: true
    });
    let nextId = 1;
    let stdoutBuffer = "";
    let stderr = "";
    const pending = new Map<
      number,
      { resolve: (value: unknown) => void; reject: (error: Error) => void }
    >();
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      rejectPromise(new Error(`MCP tool '${input.toolName}' timed out.`));
    }, input.timeoutMs);

    const cleanup = (): void => {
      clearTimeout(timer);
      pending.clear();
    };

    const send = (payload: Record<string, unknown>): void => {
      const body = safeJsonStringify(payload);
      child.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
    };

    const request = (method: string, params: Record<string, unknown>): Promise<unknown> => {
      const id = nextId;
      nextId += 1;
      const promise = new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      send({ jsonrpc: "2.0", id, method, params });
      return promise;
    };

    const notification = (method: string, params: Record<string, unknown>): void => {
      send({ jsonrpc: "2.0", method, params });
    };

    const handleMessage = (message: unknown): void => {
      if (typeof message !== "object" || message === null || !("id" in message)) {
        return;
      }
      const record = message as { id?: unknown; error?: unknown; result?: unknown };
      if (typeof record.id !== "number") {
        return;
      }
      const waiter = pending.get(record.id);
      if (!waiter) {
        return;
      }
      pending.delete(record.id);
      if (record.error) {
        waiter.reject(new Error(redactString(safeJsonStringify(record.error))));
        return;
      }
      waiter.resolve(redactMcpPayload(record.result));
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      const parsed = extractJsonRpcMessages(stdoutBuffer);
      stdoutBuffer = parsed.remaining;
      for (const message of parsed.messages) {
        handleMessage(message);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += redactString(chunk.toString("utf8"));
    });

    child.on("error", (error) => {
      cleanup();
      rejectPromise(error);
    });

    child.on("close", (exitCode) => {
      if (pending.size > 0) {
        cleanup();
        rejectPromise(
          new Error(
            `MCP server '${input.server.id}' exited before completing the request (exit ${exitCode ?? "null"}). ${stderr}`.trim()
          )
        );
      }
    });

    void (async () => {
      try {
        await request("initialize", {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: {
            name: "nexus-cli",
            version: "1.0.0"
          }
        });
        notification("notifications/initialized", {});
        const result = await request("tools/call", {
          name: input.toolName,
          arguments: input.arguments
        });
        cleanup();
        await shutdownMcpProcess(child);
        resolvePromise(result);
      } catch (error) {
        cleanup();
        await shutdownMcpProcess(child);
        rejectPromise(error instanceof Error ? error : new Error(String(error)));
      }
    })();
  });
}

async function shutdownMcpProcess(child: ReturnType<typeof spawn>): Promise<void> {
  child.stdin?.end();
  if (child.exitCode !== null || child.killed) {
    return;
  }
  const closed = new Promise<void>((resolveClose) => {
    child.once("close", () => resolveClose());
  });
  child.kill("SIGTERM");
  await Promise.race([closed, new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 1000))]);
}

function extractJsonRpcMessages(buffer: string): { messages: unknown[]; remaining: string } {
  const messages: unknown[] = [];
  let remaining = buffer;
  while (remaining.length > 0) {
    const headerEnd = findHeaderEnd(remaining);
    if (headerEnd) {
      const header = remaining.slice(0, headerEnd.index);
      const lengthMatch = /^content-length:\s*(\d+)$/im.exec(header);
      if (lengthMatch?.[1]) {
        const bodyStart = headerEnd.index + headerEnd.separator.length;
        const length = Number(lengthMatch[1]);
        if (Buffer.byteLength(remaining.slice(bodyStart), "utf8") < length) {
          break;
        }
        const body = remaining.slice(bodyStart, bodyStart + length);
        const parsed = parseJsonPayload(body);
        if (parsed !== undefined) {
          messages.push(parsed);
        }
        remaining = remaining.slice(bodyStart + length);
        continue;
      }
    }

    const newlineIndex = remaining.indexOf("\n");
    if (newlineIndex < 0) {
      break;
    }
    const line = remaining.slice(0, newlineIndex).trim();
    remaining = remaining.slice(newlineIndex + 1);
    if (!line) {
      continue;
    }
    const parsed = parseJsonPayload(line);
    if (parsed !== undefined) {
      messages.push(parsed);
    }
  }
  return { messages, remaining };
}

function findHeaderEnd(buffer: string): { index: number; separator: string } | undefined {
  const crlf = buffer.indexOf("\r\n\r\n");
  const lf = buffer.indexOf("\n\n");
  if (crlf >= 0 && (lf < 0 || crlf < lf)) {
    return { index: crlf, separator: "\r\n\r\n" };
  }
  if (lf >= 0) {
    return { index: lf, separator: "\n\n" };
  }
  return undefined;
}

function parseJsonPayload(payload: string): unknown | undefined {
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return undefined;
  }
}

function redactMcpPayload(payload: unknown): unknown {
  return JSON.parse(safeJsonStringify(payload)) as unknown;
}

async function searchDirectory(
  root: string,
  directory: string,
  query: string,
  results: SearchFileMatch[],
  maxResults: number
): Promise<void> {
  if (results.length >= maxResults) {
    return;
  }

  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (results.length >= maxResults) {
      return;
    }
    if ([".git", "node_modules", "dist", "build", ".nexus"].includes(entry.name)) {
      continue;
    }
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      await searchDirectory(root, absolutePath, query, results, maxResults);
      continue;
    }
    if (!entry.isFile() || !isTextLike(entry.name)) {
      continue;
    }
    const metadata = await stat(absolutePath).catch(() => undefined);
    if (!metadata || metadata.size > 512 * 1024) {
      continue;
    }
    const content = await readFile(absolutePath, "utf8").catch(() => "");
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length && results.length < maxResults; index += 1) {
      const text = lines[index] ?? "";
      if (text.toLowerCase().includes(query.toLowerCase())) {
        results.push({
          path: relative(root, absolutePath).replaceAll("\\", "/"),
          line: index + 1,
          text: redactString(text.trim())
        });
      }
    }
  }
}

function sanitizeEnv(source: NodeJS.ProcessEnv, extraAllowed: string[] = []): NodeJS.ProcessEnv {
  const allowed = new Set([
    "PATH",
    "Path",
    "SystemRoot",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "PNPM_HOME"
  ]);
  for (const key of extraAllowed) {
    allowed.add(key);
  }
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    if (source[key]) {
      env[key] = source[key];
    }
  }
  return env;
}

function isTextLike(filePath: string): boolean {
  const textExtensions = new Set([
    ".js",
    ".ts",
    ".tsx",
    ".jsx",
    ".json",
    ".md",
    ".txt",
    ".toml",
    ".yaml",
    ".yml",
    ".css",
    ".html"
  ]);
  return textExtensions.has(extname(filePath).toLowerCase());
}

function classifyShellRiskLocally(command: string): RiskLevel {
  return classifyCommandRisk(command);
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
