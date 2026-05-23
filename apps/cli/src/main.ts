#!/usr/bin/env node

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as readline from "node:readline/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { MinimalAgentOrchestrator, SubagentManager } from "@nexus/agent";
import { type ConfigOverrides, type ResolvedConfig, resolveConfig } from "@nexus/config";
import { type CompiledContext } from "@nexus/context";
import { InMemoryEventBus, createEvent, readJsonlEvents } from "@nexus/events";
import { LearningPlane, type LearningCandidateDraft } from "@nexus/learning";
import { McpRegistry } from "@nexus/mcp";
import { DefaultModelRouter, ModelProviderRegistry } from "@nexus/model-router";
import { DeepSeekChatProvider } from "@nexus/provider-deepseek";
import { OpenAiResponsesProvider } from "@nexus/provider-openai";
import {
  type NexusSession,
  NexusRuntime,
  type RuntimeContext,
  type RuntimeServices,
  type TurnResult,
  createDefaultRuntimeServices
} from "@nexus/runtime";
import { type ModelPlanSuggestion, type ReviewFinding, SdlcManager } from "@nexus/sdlc";
import { type ApprovalRequestRecord, SecurityRuntime } from "@nexus/security";
import { SkillRegistry } from "@nexus/skills";
import { HookRegistry, type HookPoint } from "@nexus/hooks";
import { SandboxManager } from "@nexus/sandbox";
import {
  type ApprovalRequestId,
  type LearningCandidateId,
  type MemoryId,
  NexusError,
  type SessionId,
  nowIso,
  safeJsonStringify
} from "@nexus/shared";
import { listSessionManifests } from "@nexus/storage";
import { FakeModelProvider } from "@nexus/test-utils";
import { RollbackManager, createDefaultToolBus, createToolRequest } from "@nexus/tool-bus";
import {
  clearTranscript,
  createInitialTuiState,
  parseSlashCommand,
  reduceTuiEvent,
  renderNexusTuiApp,
  renderSlashPalette,
  renderStatusLine,
  renderTranscriptEntry,
  type RuntimeIntent,
  type TuiState
} from "@nexus/tui";

const VERSION = "0.1.0";

export async function main(argv: string[] = process.argv): Promise<void> {
  const parsed = parseArgs(argv.slice(2));

  if (parsed.command === "help") {
    process.stdout.write(helpText());
    return;
  }

  if (parsed.command === "version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  if (parsed.command === "mcp") {
    await runMcpCommand(parsed);
    return;
  }

  if (parsed.command === "skills") {
    await runSkillsCommand(parsed);
    return;
  }

  if (parsed.command === "hooks") {
    await runHooksCommand(parsed);
    return;
  }

  if (parsed.command === "fork") {
    await runForkCommand(parsed);
    return;
  }

  if (parsed.command === "login") {
    await runLoginCommand(parsed);
    return;
  }

  if (parsed.command === "logout") {
    await runLogoutCommand(parsed);
    return;
  }

  if (parsed.command === "utility") {
    await runUtilityTopLevelCommand(parsed);
    return;
  }

  if (parsed.command !== "exec") {
    await runInteractive(parsed);
    return;
  }

  if (!parsed.prompt) {
    process.stderr.write("Missing prompt for `nexus exec`.\n");
    process.exitCode = 1;
    return;
  }

  try {
    const cwd = parsed.cwd ?? process.cwd();
    const config = await resolveConfig({
      cwd,
      ...(parsed.configPath ? { configPath: parsed.configPath } : {}),
      overrides: parsed.overrides
    });

    const { runtime, eventBus, services } = createRuntime(config, parsed.json, cwd);

    const session = await runtime.startSession({ cwd, mode: "non-interactive" });
    const result = await runtime.runTurn({ text: parsed.prompt, createdAt: nowIso() });
    await runPostMutationGates({
      session,
      config,
      runtime,
      services,
      eventBus,
      result,
      rollbackOnVerifyFail: parsed.rollbackOnVerifyFail ?? false,
      nonInteractive: true,
      ...(parsed.verify ? { verify: parsed.verify } : {})
    });
    await runtime.complete(result);
    await persistRequestedArtifacts({ parsed, runtime, config, services, cwd });

    if (!parsed.json && result.finalMessage) {
      process.stdout.write(`${result.finalMessage}\n`);
    }

    process.exitCode = result.exitCodeHint ?? 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = exitCodeForError(error);
  }
}

async function runInteractive(parsed: ParsedArgs): Promise<void> {
  try {
    const cwd = parsed.cwd ?? process.cwd();
    const config = await resolveConfig({
      cwd,
      ...(parsed.configPath ? { configPath: parsed.configPath } : {}),
      overrides: parsed.overrides
    });
    const { runtime, eventBus, services } = createRuntime(config, false, cwd);
    const sdlcManager = services.sdlc;
    const learningPlane = new LearningPlane({
      mode: config.learning.mode,
      requireUserConfirmation: config.learning.requireUserConfirmation
    });
    const sessionFilesChanged = new Set<string>();
    const sessionCommandsRun = new Set<string>();

    if (input.isTTY && !parsed.noAltScreen) {
      await runFullscreenInteractive({
        parsed,
        cwd,
        config,
        runtime,
        eventBus,
        services,
        sdlcManager,
        learningPlane,
        sessionFilesChanged,
        sessionCommandsRun
      });
      return;
    }

    let tuiState = createInitialTuiState(config);
    let printedTranscriptLength = 0;

    eventBus.subscribe((event) => {
      if (event.type === "file.changed") {
        const changedPath = readString(event.path);
        if (changedPath) {
          sessionFilesChanged.add(changedPath);
        }
      }
      if (event.type === "shell.completed") {
        const command = readString(event.command);
        if (command) {
          sessionCommandsRun.add(command);
        }
      }
      if (event.type === "session.completed") {
        for (const file of readStringArray(event.filesChanged)) {
          sessionFilesChanged.add(file);
        }
        for (const command of readStringArray(event.commandsRun)) {
          sessionCommandsRun.add(command);
        }
      }
      tuiState = reduceTuiEvent(tuiState, event);
      const newEntries = tuiState.transcript.slice(printedTranscriptLength);
      for (const entry of newEntries) {
        output.write(`${renderTranscriptEntry(entry)}\n`);
      }
      printedTranscriptLength = tuiState.transcript.length;
      if (event.type === "session.completed") {
        output.write(`${renderStatusLine(tuiState)}\n`);
      }
    });

    let session =
      parsed.command === "resume"
        ? await runtime.resumeSession({ cwd, last: true, mode: "interactive" })
        : await runtime.startSession({ cwd, mode: "interactive" });
    let activeTurn: Promise<void> | undefined;
    const startTurn = (text: string): void => {
      if (activeTurn) {
        output.write("A turn is already running.\n");
        return;
      }
      activeTurn = runInteractiveTurn(runtime, text)
        .then(async (result) => {
          recordTurnResult(result, sessionFilesChanged, sessionCommandsRun);
          await runPostMutationGates({
            session,
            config,
            runtime,
            services,
            eventBus,
            result,
            rollbackOnVerifyFail: false,
            nonInteractive: false
          });
          await runtime.complete(result);
        })
        .catch((error: unknown) => {
          output.write(`${error instanceof Error ? error.message : String(error)}\n`);
        })
        .finally(() => {
          activeTurn = undefined;
        });
    };
    output.write("Nexus CLI interactive mode\n");
    output.write(`${renderStatusLine(tuiState)}\n`);
    output.write(`${renderSlashPalette()}\n`);

    if (parsed.prompt) {
      startTurn(parsed.prompt);
    }

    const processComposerLine = async (line: string): Promise<boolean> => {
      const text = line.trim();
      if (!text) {
        return true;
      }
      if (text.startsWith("/")) {
        const intent = parseSlashCommand(text);
        if (intent.type === "session.quit") {
          await runtime.stop();
          if (activeTurn) {
            await activeTurn;
          }
          output.write("Session closed.\n");
          return false;
        }
        if (intent.type === "status.show") {
          output.write(`${renderStatusLine(tuiState)}\n`);
          return true;
        }
        if (intent.type === "slash.help") {
          output.write(`${renderSlashPalette()}\n`);
          return true;
        }
        if (intent.type === "model.show") {
          output.write(`Active model: ${config.modelProvider}/${config.model}\n`);
          return true;
        }
        if (intent.type === "permissions.show") {
          output.write(`Sandbox: ${config.sandboxMode} | approval: ${config.approvalPolicy}\n`);
          return true;
        }
        if (intent.type === "process.list") {
          output.write(
            `Active tools: ${tuiState.activeTools.join(", ") || "none"} | processes: ${
              tuiState.activeProcesses.map((process) => process.label).join(", ") || "none"
            }\n`
          );
          return true;
        }
        if (intent.type === "process.stop") {
          await runtime.stop();
          output.write("Stop requested for this session.\n");
          return true;
        }
        if (intent.type === "approval.list") {
          const pending = services.approvals
            .list(session.id)
            .filter((approval) => approval.status === "pending");
          if (pending.length === 0) {
            output.write("No pending approvals.\n");
            return true;
          }
          for (const approval of pending) {
            output.write(
              `${approval.id} ${approval.toolName} ${approval.risk}: ${approval.reason}\n`
            );
          }
          return true;
        }
        if (
          intent.type === "approval.approve" ||
          intent.type === "approval.approve_session" ||
          intent.type === "approval.deny"
        ) {
          const approval = await resolveApprovalRequest({
            services,
            session,
            ...(intent.argument ? { requestedId: intent.argument } : {})
          });
          if (!approval) {
            output.write("No pending approval request.\n");
            return true;
          }
          if (intent.type === "approval.approve") {
            await runtime.approve(approval.id);
            output.write(`Approved ${approval.id}.\n`);
          } else if (intent.type === "approval.approve_session") {
            await runtime.approve(approval.id, "session");
            output.write(`Approved ${approval.id} for session.\n`);
          } else {
            await runtime.deny(approval.id);
            output.write(`Denied ${approval.id}.\n`);
          }
          return true;
        }
        if (intent.type === "auth.logout") {
          output.write(
            `${(
              await logoutAuthProviders({
                cwd: session.cwd,
                config,
                providers: providersFromLogoutArgument(intent.argument, config)
              })
            ).join("\n")}\n`
          );
          return true;
        }
        if (intent.type === "config.debug") {
          const loaded = config.sources.map(
            (source) => `${source.loaded ? "loaded" : "missing"} ${source.path}`
          );
          output.write(`${loaded.join("\n")}\n`);
          return true;
        }
        if (intent.type === "diff.show") {
          output.write(`${tuiState.lastDiff ?? "No diff available."}\n`);
          return true;
        }
        if (intent.type === "transcript.clear") {
          tuiState = clearTranscript(tuiState);
          printedTranscriptLength = 0;
          output.write("Transcript cleared.\n");
          return true;
        }
        if (
          intent.type === "session.new" ||
          intent.type === "session.resume" ||
          intent.type === "session.fork"
        ) {
          if (activeTurn) {
            output.write("Cannot change sessions while a turn is running.\n");
            return true;
          }
          session =
            intent.type === "session.new"
              ? await runtime.startSession({ cwd: session.cwd, mode: "interactive" })
              : intent.type === "session.resume"
                ? await runtime.resumeSession({ cwd: session.cwd, last: true, mode: "interactive" })
                : await runtime.forkSession(session.id, { cwd: session.cwd, mode: "interactive" });
          output.write(`Active session: ${session.id}\n`);
          return true;
        }
        if (intent.type === "sdlc.goal.set") {
          if (!intent.argument) {
            output.write("Usage: /goal <objective>\n");
            return true;
          }
          const message = await handleSdlcGoalCommand({
            session,
            config,
            runtime,
            services,
            eventBus,
            sdlcManager,
            goal: intent.argument
          });
          output.write(`${message}\n`);
          return true;
        }
        if (intent.type === "sdlc.plan") {
          const message = await handleSdlcPlanCommand({
            session,
            config,
            runtime,
            services,
            eventBus,
            sdlcManager,
            ...(intent.argument ? { prompt: intent.argument } : {})
          });
          output.write(`${message}\n`);
          return true;
        }
        if (intent.type === "sdlc.verify") {
          const message = await handleSdlcVerifyCommand({
            session,
            config,
            runtime,
            services,
            eventBus,
            sdlcManager,
            sessionCommandsRun,
            ...(intent.argument ? { command: intent.argument } : {})
          });
          output.write(`${message}\n`);
          return true;
        }
        if (intent.type === "review.start") {
          const message = await handleSdlcReviewCommand({
            session,
            config,
            runtime,
            services,
            eventBus,
            sdlcManager,
            filesChanged: [...sessionFilesChanged],
            ...(tuiState.lastDiff ? { diff: tuiState.lastDiff } : {})
          });
          output.write(`${message}\n`);
          return true;
        }
        if (intent.type === "ship.start") {
          const message = await handleShipCommand({
            session,
            eventBus,
            runtime,
            sdlcManager,
            filesChanged: [...sessionFilesChanged],
            commandsRun: [...sessionCommandsRun]
          });
          output.write(`${message}\n`);
          return true;
        }
        if (intent.type === "rollback.start") {
          const rollback = await new RollbackManager().rollback({
            checkpointId: intent.argument || "latest",
            ctx: createRollbackContext({
              session,
              config,
              eventBus,
              services,
              runtime,
              nonInteractive: false
            })
          });
          await runtime.getStorage().writeArtifact("rollbackPath", safeJsonStringify(rollback));
          output.write(
            rollback.status === "restored"
              ? `Rollback restored ${rollback.restoredFiles.join(", ")}.\n`
              : `Rollback ${rollback.status}: ${rollback.refusedReason ?? "not restored"}.\n`
          );
          return true;
        }
        if (intent.type === "mcp.open") {
          output.write(`${await renderMcpStatus(session.cwd)}\n`);
          return true;
        }
        if (intent.type === "skills.open") {
          output.write(`${await renderSkillsStatus(session.cwd)}\n`);
          return true;
        }
        if (intent.type === "hooks.open") {
          output.write(`${await renderHooksStatus(session.cwd)}\n`);
          return true;
        }
        if (intent.type === "agent.open") {
          output.write(
            `${await renderAgentStatus({
              argument: intent.argument,
              session,
              config,
              runtime,
              services,
              eventBus,
              nonInteractive: false
            })}\n`
          );
          return true;
        }
        if (intent.type === "context.compact") {
          const message = await handleContextCompactCommand({
            session,
            config,
            runtime,
            services,
            eventBus,
            sdlcManager,
            learningPlane,
            commandsRun: [...sessionCommandsRun],
            filesChanged: [...sessionFilesChanged]
          });
          output.write(`${message}\n`);
          return true;
        }
        if (intent.type === "memories.open") {
          await handleMemoriesIntent({
            session,
            eventBus,
            learningPlane,
            ...(intent.argument ? { action: intent.argument } : {})
          });
          return true;
        }
        const utilityMessage = await renderUtilityIntentMessage({
          intent,
          config,
          session,
          runtime,
          services
        });
        if (utilityMessage) {
          output.write(`${utilityMessage}\n`);
          return true;
        }
        output.write(`${intent.message ?? "Command recognized but not implemented."}\n`);
        return true;
      }

      startTurn(text);
      return true;
    };

    if (!input.isTTY) {
      for (const line of await readAllInputLines(input as AsyncIterable<Buffer | string>)) {
        const shouldContinue = await processComposerLine(line);
        if (!shouldContinue) {
          break;
        }
      }
      if (activeTurn) {
        await activeTurn;
      }
      return;
    }

    const rl = readline.createInterface({ input, output });
    try {
      rl.setPrompt("nexus> ");
      rl.prompt();
      for await (const line of rl) {
        const shouldContinue = await processComposerLine(line);
        if (!shouldContinue) {
          break;
        }
        rl.prompt();
      }
    } finally {
      rl.close();
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = exitCodeForError(error);
  }
}

async function runMcpCommand(parsed: ParsedArgs): Promise<void> {
  const cwd = parsed.cwd ?? process.cwd();
  const registry = new McpRegistry();
  const [action = "list", id, ...rest] = (parsed.prompt ?? "list").split(/\s+/).filter(Boolean);
  if (action === "registry-add") {
    if (!id) {
      process.stderr.write("Usage: nexus mcp registry-add <url>\n");
      process.exitCode = 7;
      return;
    }
    const governance = await registry.addRemoteRegistry(cwd, id);
    process.stdout.write(
      `MCP remote registries: ${governance.remoteRegistries.join(", ") || "none"}\n`
    );
    return;
  }
  if (action === "registries") {
    const governance = await registry.governance(cwd);
    process.stdout.write(
      governance.remoteRegistries.length === 0
        ? "No MCP remote registries configured.\n"
        : `${governance.remoteRegistries.join("\n")}\n`
    );
    return;
  }
  if (action === "add") {
    if (!id || rest.length === 0) {
      process.stderr.write("Usage: nexus mcp add <id> <command...>\n");
      process.exitCode = 7;
      return;
    }
    const command = rest[0];
    if (!command) {
      process.stderr.write("Usage: nexus mcp add <id> <command...>\n");
      process.exitCode = 7;
      return;
    }
    await registry.add(cwd, {
      id,
      name: id,
      transport: "stdio",
      command,
      args: rest.slice(1),
      enabled: true,
      permissions: ["workspace.read"],
      trust: "untrusted",
      allowedTools: [],
      envAllowlist: []
    });
    process.stdout.write(`MCP server added: ${id} (untrusted)\n`);
    return;
  }
  if (action === "trust" || action === "untrust") {
    if (!id) {
      process.stderr.write(`Usage: nexus mcp ${action} <id>\n`);
      process.exitCode = 7;
      return;
    }
    const updated = await registry.update(cwd, id, {
      trust: action === "trust" ? "trusted" : "untrusted"
    });
    process.stdout.write(
      updated
        ? `MCP server ${action === "trust" ? "trusted" : "untrusted"}: ${id}\n`
        : `MCP server not found: ${id}\n`
    );
    return;
  }
  if (action === "allow-tool" || action === "deny-tool") {
    const toolName = rest[0];
    if (!id || !toolName) {
      process.stderr.write(`Usage: nexus mcp ${action} <id> <tool>\n`);
      process.exitCode = 7;
      return;
    }
    const updated =
      action === "allow-tool"
        ? await registry.allowTool(cwd, id, toolName)
        : await registry.denyTool(cwd, id, toolName);
    process.stdout.write(
      updated
        ? `MCP server ${id} allowed tools: ${(updated.allowedTools ?? []).join(", ") || "none"}\n`
        : `MCP server not found: ${id}\n`
    );
    return;
  }
  if (action === "enable" || action === "disable") {
    if (!id) {
      process.stderr.write(`Usage: nexus mcp ${action} <id>\n`);
      process.exitCode = 7;
      return;
    }
    const updated = await registry.update(cwd, id, { enabled: action === "enable" });
    process.stdout.write(
      updated ? `MCP server ${action}d: ${id}\n` : `MCP server not found: ${id}\n`
    );
    return;
  }
  if (action === "remove") {
    if (!id) {
      process.stderr.write("Usage: nexus mcp remove <id>\n");
      process.exitCode = 7;
      return;
    }
    const removed = await registry.remove(cwd, id);
    process.stdout.write(removed ? `MCP server removed: ${id}\n` : `MCP server not found: ${id}\n`);
    return;
  }
  const servers = await registry.list(cwd);
  process.stdout.write(
    servers.length === 0
      ? "No MCP servers configured.\n"
      : `${servers
          .map(
            (server) =>
              `${server.id} ${server.enabled ? "enabled" : "disabled"} ${server.transport} ${
                server.trust ?? "untrusted"
              } tools=${(server.allowedTools ?? []).join(",") || "none"} governance=${
                server.governance?.policyVersion ?? "pending"
              }`
          )
          .join("\n")}\n`
  );
}

async function runSkillsCommand(parsed: ParsedArgs): Promise<void> {
  const cwd = parsed.cwd ?? process.cwd();
  const skills = await new SkillRegistry().summaries(cwd);
  process.stdout.write(
    skills.length === 0
      ? "No skills available.\n"
      : `${skills.map((skill) => `${skill.id}: ${skill.description}`).join("\n")}\n`
  );
}

async function runHooksCommand(parsed: ParsedArgs): Promise<void> {
  const cwd = parsed.cwd ?? process.cwd();
  const hooks = await new HookRegistry().list(cwd);
  process.stdout.write(
    hooks.length === 0
      ? "No hooks configured.\n"
      : `${hooks.map((hook) => `${hook.id} ${hook.enabled ? "enabled" : "disabled"} ${hook.event}`).join("\n")}\n`
  );
}

async function runForkCommand(parsed: ParsedArgs): Promise<void> {
  try {
    const cwd = parsed.cwd ?? process.cwd();
    const config = await resolveConfig({
      cwd,
      ...(parsed.configPath ? { configPath: parsed.configPath } : {}),
      overrides: parsed.overrides
    });
    const { runtime, eventBus, services } = createRuntime(config, parsed.json, cwd);
    const forkInput = parseForkInput(parsed.prompt);
    const parentSessionId = forkInput.sessionId ?? (await latestSessionId(cwd));
    if (!parentSessionId) {
      throw new NexusError({
        category: "storage",
        message: "No previous session was found to fork. Start or run a session first.",
        recoverable: true
      });
    }

    const session = await runtime.forkSession(parentSessionId, {
      cwd,
      mode: forkInput.prompt ? "non-interactive" : "interactive"
    });
    if (!forkInput.prompt) {
      process.stdout.write(
        `Forked session ${session.id} from ${parentSessionId}. Resume with: nexus resume --cd ${cwd}\n`
      );
      return;
    }

    const result = await runtime.runTurn({ text: forkInput.prompt, createdAt: nowIso() });
    await runPostMutationGates({
      session,
      config,
      runtime,
      services,
      eventBus,
      result,
      rollbackOnVerifyFail: parsed.rollbackOnVerifyFail ?? false,
      nonInteractive: true,
      ...(parsed.verify ? { verify: parsed.verify } : {})
    });
    await runtime.complete(result);
    await persistRequestedArtifacts({ parsed, runtime, config, services, cwd });
    if (!parsed.json && result.finalMessage) {
      process.stdout.write(`${result.finalMessage}\n`);
    }
    process.exitCode = result.exitCodeHint ?? 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = exitCodeForError(error);
  }
}

async function runLoginCommand(parsed: ParsedArgs): Promise<void> {
  try {
    const cwd = parsed.cwd ?? process.cwd();
    const config = await resolveConfig({
      cwd,
      ...(parsed.configPath ? { configPath: parsed.configPath } : {}),
      overrides: parsed.overrides
    });
    const provider = parseAuthProvider(parsed, config);
    const apiKeyEnv = config.providers[provider]?.apiKeyEnv ?? defaultProviderApiKeyEnv(provider);
    const apiKey = parsed.authApiKey ?? process.env[apiKeyEnv];
    if (!apiKey) {
      throw new NexusError({
        category: "auth",
        message: `Missing API key for ${provider}. Use --api-key or set ${apiKeyEnv}.`,
        recoverable: true
      });
    }

    const authFilePath = resolveAuthFilePath({
      cwd,
      provider,
      config,
      ...(parsed.authFile ? { overridePath: parsed.authFile } : {})
    });
    const record = await readAuthFile(authFilePath);
    const providers = readProvidersRecord(record);
    providers[provider] = {
      apiKey,
      ...(provider === "openai" && parsed.authOrganization
        ? { organization: parsed.authOrganization }
        : {}),
      ...(provider === "openai" && parsed.authProject ? { project: parsed.authProject } : {})
    };
    delete record[provider];
    record.providers = providers;
    await writeAuthFile(authFilePath, record);
    process.stdout.write(`Stored ${provider} auth in ${authFilePath}.\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = exitCodeForError(error);
  }
}

async function runLogoutCommand(parsed: ParsedArgs): Promise<void> {
  try {
    const cwd = parsed.cwd ?? process.cwd();
    const config = await resolveConfig({
      cwd,
      ...(parsed.configPath ? { configPath: parsed.configPath } : {}),
      overrides: parsed.overrides
    });
    const providers =
      parsed.authAll || parsed.prompt?.trim().split(/\s+/).find(Boolean) === "all"
        ? supportedAuthProviders()
        : [parseAuthProvider(parsed, config)];
    process.stdout.write(
      `${(
        await logoutAuthProviders({
          cwd,
          config,
          providers,
          ...(parsed.authFile ? { overridePath: parsed.authFile } : {})
        })
      ).join("\n")}\n`
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = exitCodeForError(error);
  }
}

async function runUtilityTopLevelCommand(parsed: ParsedArgs): Promise<void> {
  const cwd = parsed.cwd ?? process.cwd();
  switch (parsed.utilityCommand) {
    case "init":
      process.stdout.write(`${await initializeProject(cwd)}\n`);
      return;
    case "completion":
      process.stdout.write(
        "Shell completion generation is not persisted automatically; use the documented slash commands from nexus --help.\n"
      );
      return;
    case "features": {
      const config = await resolveConfig({
        cwd,
        ...(parsed.configPath ? { configPath: parsed.configPath } : {}),
        overrides: parsed.overrides
      });
      process.stdout.write(`${safeJsonStringify(config.features)}\n`);
      return;
    }
    case "sandbox": {
      const config = await resolveConfig({
        cwd,
        ...(parsed.configPath ? { configPath: parsed.configPath } : {}),
        overrides: parsed.overrides
      });
      if (parsed.prompt?.trim() === "doctor") {
        process.stdout.write(`${await new SandboxManager().doctor(process.platform)}\n`);
        return;
      }
      process.stdout.write(
        [
          `Sandbox mode: ${config.sandboxMode}; hard sandbox required: ${config.security.requireHardSandbox}`,
          "Shell/test commands require a hard sandbox and fail closed when Docker/Podman is unavailable.",
          `Adapter: ${config.sandbox.preferredAdapter}; container: ${config.sandbox.containerRuntime}/${config.sandbox.containerImage}`,
          "Run `nexus sandbox doctor` to inspect hard sandbox availability."
        ].join("\n") + "\n"
      );
      return;
    }
    case "ship":
      process.stdout.write(
        "Ship artifacts are generated inside an active session with /ship after verification and review gates run.\n"
      );
      return;
    case "memories":
      process.stdout.write(
        "Memory management is available inside an active session with /memories.\n"
      );
      return;
    case "update":
      process.stdout.write(
        "Update check complete: this local workspace build does not self-update.\n"
      );
      return;
    case "apply":
      process.stdout.write(
        "Apply reads patches from model/tool output inside sessions. Use exec or interactive mode for patch application.\n"
      );
      return;
    case "cloud":
      process.stdout.write("Cloud sync is disabled by default for v1.0 local-first operation.\n");
      return;
    case "app-server":
      process.stdout.write(
        "App server integrations are controlled by configured MCP/app connectors.\n"
      );
      return;
    default:
      process.stdout.write("Command recognized. Use nexus --help for supported options.\n");
  }
}

type AuthProviderId = "deepseek" | "openai";

function parseForkInput(value: string | undefined): {
  sessionId?: SessionId;
  prompt?: string;
} {
  const trimmed = value?.trim();
  if (!trimmed) {
    return {};
  }
  const [first = "", ...rest] = trimmed.split(/\s+/);
  if (first.startsWith("nx_")) {
    const prompt = rest.join(" ").trim();
    return {
      sessionId: first as unknown as SessionId,
      ...(prompt ? { prompt } : {})
    };
  }
  return { prompt: trimmed };
}

async function latestSessionId(cwd: string): Promise<SessionId | undefined> {
  const [latest] = await listSessionManifests({ cwd });
  return latest?.sessionId;
}

function parseAuthProvider(parsed: ParsedArgs, config: ResolvedConfig): AuthProviderId {
  const candidate =
    parsed.authProvider ?? parsed.prompt?.trim().split(/\s+/).find(Boolean) ?? config.modelProvider;
  if (candidate === "deepseek" || candidate === "openai") {
    return candidate;
  }
  throw new NexusError({
    category: "auth",
    message: `Provider '${candidate}' does not support CLI auth. Supported providers: ${supportedAuthProviders().join(", ")}.`,
    recoverable: true
  });
}

function providersFromLogoutArgument(
  argument: string | undefined,
  config: ResolvedConfig
): AuthProviderId[] {
  const candidate = argument?.trim().split(/\s+/).find(Boolean);
  if (candidate === "all" || candidate === "--all") {
    return supportedAuthProviders();
  }
  if (!candidate) {
    return [parseAuthProvider({ command: "logout", json: false, overrides: {} }, config)];
  }
  return [
    parseAuthProvider(
      { command: "logout", json: false, overrides: {}, authProvider: candidate },
      config
    )
  ];
}

function supportedAuthProviders(): AuthProviderId[] {
  return ["deepseek", "openai"];
}

function defaultProviderApiKeyEnv(provider: AuthProviderId): string {
  return provider === "openai" ? "OPENAI_API_KEY" : "DEEPSEEK_API_KEY";
}

function resolveAuthFilePath(input: {
  cwd: string;
  provider: AuthProviderId;
  config: ResolvedConfig;
  overridePath?: string;
}): string {
  const configured = input.overridePath ?? input.config.providers[input.provider]?.authFile;
  if (configured) {
    return isAbsolute(configured) ? configured : resolve(input.cwd, configured);
  }
  return join(homedir(), ".nexus", "auth.json");
}

async function logoutAuthProviders(input: {
  cwd: string;
  config: ResolvedConfig;
  providers: AuthProviderId[];
  overridePath?: string;
}): Promise<string[]> {
  const messages: string[] = [];
  for (const provider of input.providers) {
    const authFilePath = resolveAuthFilePath({
      cwd: input.cwd,
      provider,
      config: input.config,
      ...(input.overridePath ? { overridePath: input.overridePath } : {})
    });
    const record = await readAuthFile(authFilePath);
    const nestedProviders = readProvidersRecord(record);
    const hadAuth = Boolean(nestedProviders[provider] ?? record[provider]);
    delete nestedProviders[provider];
    delete record[provider];
    record.providers = nestedProviders;
    await writeAuthFile(authFilePath, record);
    const apiKeyEnv =
      input.config.providers[provider]?.apiKeyEnv ?? defaultProviderApiKeyEnv(provider);
    messages.push(
      hadAuth
        ? `Removed ${provider} persisted auth from ${authFilePath}.`
        : `No persisted ${provider} auth found in ${authFilePath}.`
    );
    if (process.env[apiKeyEnv]) {
      messages.push(`${apiKeyEnv} is still set; unset it to fully deauthenticate ${provider}.`);
    }
  }
  return messages;
}

async function readAuthFile(filePath: string): Promise<Record<string, unknown>> {
  const content = await readFile(filePath, "utf8").catch(() => undefined);
  if (!content) {
    return {};
  }
  try {
    const parsed = JSON.parse(content) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    throw new NexusError({
      category: "auth",
      message: `Auth file is not valid JSON: ${filePath}`,
      recoverable: true
    });
  }
}

async function writeAuthFile(filePath: string, record: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await chmod(filePath, 0o600).catch(() => undefined);
}

function readProvidersRecord(
  record: Record<string, unknown>
): Record<string, Record<string, unknown>> {
  const providers = isRecord(record.providers) ? record.providers : {};
  const result: Record<string, Record<string, unknown>> = {};
  for (const [provider, value] of Object.entries(providers)) {
    if (isRecord(value)) {
      result[provider] = { ...value };
    }
  }
  return result;
}

async function runFullscreenInteractive(inputData: {
  parsed: ParsedArgs;
  cwd: string;
  config: ResolvedConfig;
  runtime: NexusRuntime;
  eventBus: InMemoryEventBus;
  services: RuntimeServices;
  sdlcManager: SdlcManager;
  learningPlane: LearningPlane;
  sessionFilesChanged: Set<string>;
  sessionCommandsRun: Set<string>;
}): Promise<void> {
  let tuiState: TuiState = createInitialTuiState(inputData.config);
  let session: NexusSession;
  let activeTurn: Promise<void> | undefined;
  let renderer: ReturnType<typeof renderNexusTuiApp> | undefined;

  const rerender = (): void => {
    renderer?.rerender({
      state: tuiState,
      isRunning: Boolean(activeTurn),
      onSubmitPrompt: startTurn,
      onIntent: dispatchIntent
    });
  };

  inputData.eventBus.subscribe((event) => {
    if (event.type === "file.changed") {
      const changedPath = readString(event.path);
      if (changedPath) {
        inputData.sessionFilesChanged.add(changedPath);
      }
    }
    if (event.type === "shell.completed") {
      const command = readString(event.command);
      if (command) {
        inputData.sessionCommandsRun.add(command);
      }
    }
    if (event.type === "session.completed") {
      for (const file of readStringArray(event.filesChanged)) {
        inputData.sessionFilesChanged.add(file);
      }
      for (const command of readStringArray(event.commandsRun)) {
        inputData.sessionCommandsRun.add(command);
      }
    }
    tuiState = reduceTuiEvent(tuiState, event);
    rerender();
  });

  const publishMessage = async (text: string): Promise<void> => {
    await inputData.eventBus.publish(
      createEvent({
        sessionId: session.id,
        type: "assistant.message",
        data: { text }
      })
    );
  };

  function startTurn(text: string): void {
    if (activeTurn) {
      void publishMessage("A turn is already running.");
      return;
    }
    activeTurn = runInteractiveTurn(inputData.runtime, text)
      .then(async (result) => {
        recordTurnResult(result, inputData.sessionFilesChanged, inputData.sessionCommandsRun);
        await runPostMutationGates({
          session,
          config: inputData.config,
          runtime: inputData.runtime,
          services: inputData.services,
          eventBus: inputData.eventBus,
          result,
          rollbackOnVerifyFail: false,
          nonInteractive: false
        });
        await inputData.runtime.complete(result);
      })
      .catch(async (error: unknown) => {
        await publishMessage(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        activeTurn = undefined;
        rerender();
      });
    rerender();
  }

  async function dispatchIntent(intent: RuntimeIntent): Promise<void> {
    const keepRunning = await handleFullscreenIntent({
      intent,
      config: inputData.config,
      runtime: inputData.runtime,
      services: inputData.services,
      eventBus: inputData.eventBus,
      sdlcManager: inputData.sdlcManager,
      learningPlane: inputData.learningPlane,
      getSession: () => session,
      setSession: (nextSession) => {
        session = nextSession;
      },
      getTuiState: () => tuiState,
      setTuiState: (nextState) => {
        tuiState = nextState;
        rerender();
      },
      activeTurn,
      sessionFilesChanged: inputData.sessionFilesChanged,
      sessionCommandsRun: inputData.sessionCommandsRun,
      publishMessage
    });
    if (!keepRunning) {
      renderer?.unmount();
    }
  }

  output.write("\x1b[?1049h\x1b[H");
  try {
    session =
      inputData.parsed.command === "resume"
        ? await inputData.runtime.resumeSession({
            cwd: inputData.cwd,
            last: true,
            mode: "interactive"
          })
        : await inputData.runtime.startSession({ cwd: inputData.cwd, mode: "interactive" });
    renderer = renderNexusTuiApp({
      state: tuiState,
      isRunning: false,
      onSubmitPrompt: startTurn,
      onIntent: dispatchIntent
    });

    if (inputData.parsed.prompt) {
      startTurn(inputData.parsed.prompt);
    }

    await renderer.waitUntilExit();
  } finally {
    output.write("\x1b[?1049l");
  }
}

async function handleFullscreenIntent(inputData: {
  intent: RuntimeIntent;
  config: ResolvedConfig;
  runtime: NexusRuntime;
  services: RuntimeServices;
  eventBus: InMemoryEventBus;
  sdlcManager: SdlcManager;
  learningPlane: LearningPlane;
  getSession: () => NexusSession;
  setSession: (session: NexusSession) => void;
  getTuiState: () => TuiState;
  setTuiState: (state: TuiState) => void;
  activeTurn: Promise<void> | undefined;
  sessionFilesChanged: Set<string>;
  sessionCommandsRun: Set<string>;
  publishMessage: (text: string) => Promise<void>;
}): Promise<boolean> {
  const session = inputData.getSession();
  const intent = inputData.intent;
  if (intent.type === "session.quit") {
    await inputData.runtime.stop();
    if (inputData.activeTurn) {
      await inputData.activeTurn;
    }
    return false;
  }
  if (intent.type === "status.show") {
    await inputData.publishMessage(renderStatusLine(inputData.getTuiState()));
    return true;
  }
  if (intent.type === "slash.help") {
    await inputData.publishMessage(renderSlashPalette());
    return true;
  }
  if (intent.type === "model.show") {
    await inputData.publishMessage(
      `Active model: ${inputData.config.modelProvider}/${inputData.config.model}`
    );
    return true;
  }
  if (intent.type === "permissions.show") {
    await inputData.publishMessage(
      `Sandbox: ${inputData.config.sandboxMode} | approval: ${inputData.config.approvalPolicy}`
    );
    return true;
  }
  if (intent.type === "process.list") {
    const state = inputData.getTuiState();
    const tools = state.activeTools.length > 0 ? state.activeTools.join(", ") : "none";
    const processes =
      state.activeProcesses.length > 0
        ? state.activeProcesses.map((item) => item.label).join(", ")
        : "none";
    await inputData.publishMessage(`Active tools: ${tools}; processes: ${processes}`);
    return true;
  }
  if (intent.type === "process.stop") {
    await inputData.runtime.stop();
    await inputData.publishMessage("Stop requested for this session.");
    return true;
  }
  if (intent.type === "approval.list") {
    const pending = inputData.services.approvals
      .list(session.id)
      .filter((approval) => approval.status === "pending");
    await inputData.publishMessage(
      pending.length === 0
        ? "No pending approvals."
        : pending
            .map(
              (approval) =>
                `${approval.id} ${approval.toolName} ${approval.risk}: ${approval.reason}`
            )
            .join("\n")
    );
    return true;
  }
  if (
    intent.type === "approval.approve" ||
    intent.type === "approval.approve_session" ||
    intent.type === "approval.deny"
  ) {
    const approval = await resolveApprovalRequest({
      services: inputData.services,
      session,
      ...(intent.argument ? { requestedId: intent.argument } : {})
    });
    if (!approval) {
      await inputData.publishMessage("No pending approval request.");
      return true;
    }
    if (intent.type === "approval.deny") {
      await inputData.runtime.deny(approval.id);
      await inputData.publishMessage(`Denied ${approval.id}.`);
      return true;
    }
    await inputData.runtime.approve(
      approval.id,
      intent.type === "approval.approve_session" ? "session" : "once"
    );
    await inputData.publishMessage(
      `Approved ${approval.id}${intent.type === "approval.approve_session" ? " for session" : ""}.`
    );
    return true;
  }
  if (intent.type === "auth.logout") {
    await inputData.publishMessage(
      (
        await logoutAuthProviders({
          cwd: session.cwd,
          config: inputData.config,
          providers: providersFromLogoutArgument(intent.argument, inputData.config)
        })
      ).join("\n")
    );
    return true;
  }
  if (intent.type === "config.debug") {
    const loaded = inputData.config.sources.map(
      (source) => `${source.loaded ? "loaded" : "missing"} ${source.path}`
    );
    await inputData.publishMessage(loaded.join("\n"));
    return true;
  }
  if (intent.type === "diff.show") {
    await inputData.publishMessage(inputData.getTuiState().lastDiff ?? "No diff available.");
    return true;
  }
  if (intent.type === "transcript.clear") {
    inputData.setTuiState(clearTranscript(inputData.getTuiState()));
    return true;
  }
  if (
    intent.type === "session.new" ||
    intent.type === "session.resume" ||
    intent.type === "session.fork"
  ) {
    if (inputData.activeTurn) {
      await inputData.publishMessage("Cannot change sessions while a turn is running.");
      return true;
    }
    const nextSession =
      intent.type === "session.new"
        ? await inputData.runtime.startSession({ cwd: session.cwd, mode: "interactive" })
        : intent.type === "session.resume"
          ? await inputData.runtime.resumeSession({
              cwd: session.cwd,
              last: true,
              mode: "interactive"
            })
          : await inputData.runtime.forkSession(session.id, {
              cwd: session.cwd,
              mode: "interactive"
            });
    inputData.setSession(nextSession);
    await inputData.publishMessage(`Active session: ${nextSession.id}`);
    return true;
  }
  if (intent.type === "sdlc.goal.set") {
    if (!intent.argument) {
      await inputData.publishMessage("Usage: /goal <objective>");
      return true;
    }
    await inputData.publishMessage(
      await handleSdlcGoalCommand({
        session,
        config: inputData.config,
        runtime: inputData.runtime,
        services: inputData.services,
        eventBus: inputData.eventBus,
        sdlcManager: inputData.sdlcManager,
        goal: intent.argument
      })
    );
    return true;
  }
  if (intent.type === "sdlc.plan") {
    await inputData.publishMessage(
      await handleSdlcPlanCommand({
        session,
        config: inputData.config,
        runtime: inputData.runtime,
        services: inputData.services,
        eventBus: inputData.eventBus,
        sdlcManager: inputData.sdlcManager,
        ...(intent.argument ? { prompt: intent.argument } : {})
      })
    );
    return true;
  }
  if (intent.type === "sdlc.verify") {
    await inputData.publishMessage(
      await handleSdlcVerifyCommand({
        session,
        config: inputData.config,
        runtime: inputData.runtime,
        services: inputData.services,
        eventBus: inputData.eventBus,
        sdlcManager: inputData.sdlcManager,
        sessionCommandsRun: inputData.sessionCommandsRun,
        ...(intent.argument ? { command: intent.argument } : {})
      })
    );
    return true;
  }
  if (intent.type === "review.start") {
    await inputData.publishMessage(
      await handleSdlcReviewCommand({
        session,
        config: inputData.config,
        runtime: inputData.runtime,
        services: inputData.services,
        eventBus: inputData.eventBus,
        sdlcManager: inputData.sdlcManager,
        filesChanged: [...inputData.sessionFilesChanged],
        ...(inputData.getTuiState().lastDiff ? { diff: inputData.getTuiState().lastDiff } : {})
      })
    );
    return true;
  }
  if (intent.type === "ship.start") {
    await inputData.publishMessage(
      await handleShipCommand({
        session,
        eventBus: inputData.eventBus,
        runtime: inputData.runtime,
        sdlcManager: inputData.sdlcManager,
        filesChanged: [...inputData.sessionFilesChanged],
        commandsRun: [...inputData.sessionCommandsRun]
      })
    );
    return true;
  }
  if (intent.type === "rollback.start") {
    const rollback = await new RollbackManager().rollback({
      checkpointId: intent.argument || "latest",
      ctx: createRollbackContext({
        session,
        config: inputData.config,
        eventBus: inputData.eventBus,
        services: inputData.services,
        runtime: inputData.runtime,
        nonInteractive: false
      })
    });
    await inputData.runtime.getStorage().writeArtifact("rollbackPath", safeJsonStringify(rollback));
    await inputData.publishMessage(
      rollback.status === "restored"
        ? `Rollback restored ${rollback.restoredFiles.join(", ")}.`
        : `Rollback ${rollback.status}: ${rollback.refusedReason ?? "not restored"}.`
    );
    return true;
  }
  if (intent.type === "mcp.open") {
    await inputData.publishMessage(await renderMcpStatus(session.cwd));
    return true;
  }
  if (intent.type === "skills.open") {
    await inputData.publishMessage(await renderSkillsStatus(session.cwd));
    return true;
  }
  if (intent.type === "hooks.open") {
    await inputData.publishMessage(await renderHooksStatus(session.cwd));
    return true;
  }
  if (intent.type === "agent.open") {
    await inputData.publishMessage(
      await renderAgentStatus({
        argument: intent.argument,
        session,
        config: inputData.config,
        runtime: inputData.runtime,
        services: inputData.services,
        eventBus: inputData.eventBus,
        nonInteractive: false
      })
    );
    return true;
  }
  if (intent.type === "context.compact") {
    await inputData.publishMessage(
      await handleContextCompactCommand({
        session,
        config: inputData.config,
        runtime: inputData.runtime,
        services: inputData.services,
        eventBus: inputData.eventBus,
        sdlcManager: inputData.sdlcManager,
        learningPlane: inputData.learningPlane,
        commandsRun: [...inputData.sessionCommandsRun],
        filesChanged: [...inputData.sessionFilesChanged]
      })
    );
    return true;
  }
  if (intent.type === "memories.open") {
    const message = await handleMemoriesIntentForMessage({
      session,
      eventBus: inputData.eventBus,
      learningPlane: inputData.learningPlane,
      ...(intent.argument ? { action: intent.argument } : {})
    });
    await inputData.publishMessage(message);
    return true;
  }

  const utilityMessage = await renderUtilityIntentMessage({
    intent,
    config: inputData.config,
    session,
    runtime: inputData.runtime,
    services: inputData.services
  });
  if (utilityMessage) {
    await inputData.publishMessage(utilityMessage);
    return true;
  }

  await inputData.publishMessage(intent.message ?? "Command recognized but not implemented.");
  return true;
}

function createRuntime(
  config: ResolvedConfig,
  streamJson: boolean,
  cwd: string
): { runtime: NexusRuntime; eventBus: InMemoryEventBus; services: RuntimeServices } {
  const eventBus = new InMemoryEventBus();
  if (streamJson) {
    eventBus.subscribe((event) => {
      process.stdout.write(`${safeJsonStringify(event)}\n`);
    });
  }

  const registry = new ModelProviderRegistry();
  registry.register(new FakeModelProvider());
  registry.register(new OpenAiResponsesProvider({ config: config.providers.openai ?? {}, cwd }));
  registry.register(new DeepSeekChatProvider({ config: config.providers.deepseek ?? {}, cwd }));
  const modelRouter = new DefaultModelRouter(registry, {
    allowedProviders: config.policy.allowedProviders,
    allowedModels: config.policy.allowedModels
  });
  const security = new SecurityRuntime();
  const tools = createDefaultToolBus();
  const services = createDefaultRuntimeServices({
    models: modelRouter,
    security,
    tools
  });

  return {
    eventBus,
    services,
    runtime: new NexusRuntime({
      config,
      services,
      turnRunner: new MinimalAgentOrchestrator(),
      eventBus
    })
  };
}

async function runInteractiveTurn(runtime: NexusRuntime, text: string): Promise<TurnResult> {
  return runtime.runTurn({ text, createdAt: nowIso() });
}

async function readAllInputLines(stream: AsyncIterable<Buffer | string>): Promise<string[]> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
  }
  return Buffer.concat(chunks).toString("utf8").split(/\r?\n/);
}

async function resolveApprovalRequest(input: {
  services: RuntimeServices;
  session: NexusSession;
  requestedId?: string;
}): Promise<ApprovalRequestRecord | undefined> {
  const requested = input.requestedId?.trim();
  if (requested) {
    const match = input.services.approvals
      .list(input.session.id)
      .find(
        (approval) =>
          approval.id === (requested as unknown as ApprovalRequestId) &&
          approval.status === "pending"
      );
    if (match) {
      return match;
    }
  }

  const started = Date.now();
  while (Date.now() - started < 5000) {
    const latest = input.services.approvals.latestPending(input.session.id);
    if (latest) {
      return latest;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  return undefined;
}

async function runVerificationCommand(input: {
  session: NexusSession;
  config: ResolvedConfig;
  eventBus: InMemoryEventBus;
  services: RuntimeServices;
  command: string;
  nonInteractive?: boolean;
}): Promise<{ passed: boolean; summary: string; commandsRun: string[] }> {
  const result = await input.services.tools.execute(
    createToolRequest({
      toolName: "test.run",
      input: {
        command: input.command,
        timeoutMs: 300000,
        maxOutputBytes: 1024 * 1024
      },
      source: "sdlc",
      reason: "SDLC verification"
    }),
    {
      sessionId: input.session.id,
      cwd: input.session.cwd,
      runDirectory: dirname(input.session.eventLogPath),
      config: input.config,
      eventBus: input.eventBus,
      security: input.services.security,
      approvals: input.services.approvals,
      sandbox: input.services.sandbox,
      nonInteractive: input.nonInteractive ?? false
    }
  );
  const outputStatus = readOutputStatus(result.output);
  return {
    passed: result.status === "success" && outputStatus !== "failed",
    summary: result.summary ?? result.error?.message ?? "Verification completed.",
    commandsRun: result.commandsRun
  };
}

async function runPostMutationGates(input: {
  session: NexusSession;
  config: ResolvedConfig;
  runtime: NexusRuntime;
  services: RuntimeServices;
  eventBus: InMemoryEventBus;
  result: TurnResult;
  verify?: string;
  rollbackOnVerifyFail: boolean;
  nonInteractive: boolean;
}): Promise<void> {
  if (input.result.filesChanged.length === 0 && !input.verify) {
    return;
  }

  await input.services.sdlc.markImplement({
    sessionId: input.session.id,
    eventBus: input.eventBus,
    filesChanged: input.result.filesChanged
  });

  if (
    input.verify ||
    (input.result.filesChanged.length > 0 && input.config.sdlc.requireVerification)
  ) {
    const command =
      !input.verify || input.verify === "auto"
        ? await detectAutoVerificationCommand(input.session.cwd, input.config)
        : input.verify;
    await runLifecycleHooks({
      point: "before_verify",
      session: input.session,
      config: input.config,
      eventBus: input.eventBus,
      services: input.services,
      runtime: input.runtime,
      nonInteractive: input.nonInteractive
    });
    const verification = await runVerificationCommand({
      session: input.session,
      config: input.config,
      eventBus: input.eventBus,
      services: input.services,
      command,
      nonInteractive: input.nonInteractive
    });
    input.result.commandsRun = [
      ...new Set([...input.result.commandsRun, ...verification.commandsRun])
    ];
    const report = await input.services.sdlc.verify({
      sessionId: input.session.id,
      eventBus: input.eventBus,
      command,
      status: verification.passed ? "passed" : "failed",
      summary: verification.summary,
      required: true
    });
    input.result.finalMessage =
      `${input.result.finalMessage ?? ""}\n\nVerification ${report.status}: ${report.summary}`.trim();
    await input.runtime.getStorage().writeArtifact("verificationPath", safeJsonStringify(report));
    if (!verification.passed) {
      input.result.exitCodeHint = 6;
      if (input.rollbackOnVerifyFail) {
        const rollback = await new RollbackManager().rollback({
          checkpointId: "latest",
          ctx: createRollbackContext({
            session: input.session,
            config: input.config,
            eventBus: input.eventBus,
            services: input.services,
            runtime: input.runtime,
            nonInteractive: input.nonInteractive
          })
        });
        await input.runtime.getStorage().writeArtifact("rollbackPath", safeJsonStringify(rollback));
      }
    }
    await runLifecycleHooks({
      point: "after_verify",
      session: input.session,
      config: input.config,
      eventBus: input.eventBus,
      services: input.services,
      runtime: input.runtime,
      nonInteractive: input.nonInteractive
    });
  }

  if (
    input.result.filesChanged.length > 0 &&
    input.config.sdlc.requireReviewForSecuritySensitiveChanges
  ) {
    await runLifecycleHooks({
      point: "before_review",
      session: input.session,
      config: input.config,
      eventBus: input.eventBus,
      services: input.services,
      runtime: input.runtime,
      nonInteractive: input.nonInteractive
    });
    const context = await input.services.context.compile({
      cwd: input.session.cwd,
      config: input.config
    });
    const eventDiff = await readRecordedDiff(input.runtime);
    const diff = context.repository.git.diff || eventDiff;
    const review = await input.services.sdlc.review({
      sessionId: input.session.id,
      eventBus: input.eventBus,
      filesChanged: input.result.filesChanged,
      ...(diff ? { diff } : {}),
      context
    });
    input.result.finalMessage =
      `${input.result.finalMessage ?? ""}\n\nReview ${review.status}: ${review.summary}`.trim();
    await persistContextArtifact(input.runtime, context);
    if (diff) {
      await input.runtime.getStorage().writeArtifact("diffPatchPath", diff);
    }
    await input.runtime.getStorage().writeArtifact("reviewPath", safeJsonStringify(review));
    if (review.status === "failed" && !input.result.exitCodeHint) {
      input.result.exitCodeHint = 1;
    }
    await runLifecycleHooks({
      point: "after_review",
      session: input.session,
      config: input.config,
      eventBus: input.eventBus,
      services: input.services,
      runtime: input.runtime,
      nonInteractive: input.nonInteractive
    });
  }

  const state = input.services.sdlc.getState();
  await persistSdlcManifest(input.runtime, input.services.sdlc, {
    ...(state.verification ? { verificationStatus: state.verification.status } : {}),
    ...(state.review ? { reviewStatus: state.review.status } : {})
  });
}

async function readRecordedDiff(runtime: NexusRuntime): Promise<string> {
  const events = await readJsonlEvents(runtime.getStorage().eventLogPath).catch(() => []);
  const diffs = events
    .map((event) => (typeof event.diff === "string" ? event.diff : ""))
    .filter((diff) => diff.trim().length > 0);
  return [...new Set(diffs)].join("\n\n");
}

async function persistRequestedArtifacts(input: {
  parsed: ParsedArgs;
  runtime: NexusRuntime;
  config: ResolvedConfig;
  services: RuntimeServices;
  cwd: string;
}): Promise<void> {
  const storage = input.runtime.getStorage();
  const diff = await readRecordedDiff(input.runtime);
  if (diff) {
    await storage.writeArtifact("diffPatchPath", diff);
  }

  const artifacts: Array<{ target: string | undefined; sourcePath: string; fallback?: string }> = [
    {
      target: input.parsed.outputPath,
      sourcePath: storage.artifacts.finalAnswerPath,
      fallback: ""
    },
    { target: input.parsed.patchPath, sourcePath: storage.artifacts.diffPatchPath, fallback: diff },
    {
      target: input.parsed.reportPath,
      sourcePath: storage.artifacts.verificationPath,
      fallback: "{}\n"
    },
    { target: input.parsed.eventsPath, sourcePath: storage.eventLogPath, fallback: "" },
    {
      target: input.parsed.reviewReportPath,
      sourcePath: storage.artifacts.reviewPath,
      fallback: "{}\n"
    },
    {
      target: input.parsed.learningCandidatesPath,
      sourcePath: storage.artifacts.learningCandidatesPath,
      fallback: "[]\n"
    }
  ];

  for (const artifact of artifacts) {
    if (!artifact.target) {
      continue;
    }
    const content = await readFile(artifact.sourcePath, "utf8").catch(
      () => artifact.fallback ?? ""
    );
    await writeExternalArtifact({
      cwd: input.cwd,
      targetPath: artifact.target,
      content,
      config: input.config,
      services: input.services
    });
  }
}

async function writeExternalArtifact(input: {
  cwd: string;
  targetPath: string;
  content: string;
  config: ResolvedConfig;
  services: RuntimeServices;
}): Promise<void> {
  const guarded = await input.services.security.guardPath({
    cwd: input.cwd,
    path: input.targetPath,
    config: input.config,
    operation: "write"
  });
  if (!guarded.allowed) {
    throw new NexusError({
      category: "security",
      message: guarded.reason ?? "Artifact path denied by policy.",
      recoverable: true
    });
  }
  await mkdir(dirname(guarded.absolutePath), { recursive: true });
  await writeFile(guarded.absolutePath, input.content, "utf8");
}

async function detectAutoVerificationCommand(cwd: string, config: ResolvedConfig): Promise<string> {
  const context = await createDefaultRuntimeServices({
    models: new DefaultModelRouter(new ModelProviderRegistry()),
    tools: createDefaultToolBus(),
    security: new SecurityRuntime()
  }).context.compile({ cwd, config });
  return (
    context.repository.testCommands[0] ??
    packageCommandFallback(context.repository.packageManager, "test")
  );
}

function createRollbackContext(input: {
  session: NexusSession;
  config: ResolvedConfig;
  eventBus: InMemoryEventBus;
  services: RuntimeServices;
  runtime: NexusRuntime;
  nonInteractive: boolean;
}) {
  return {
    sessionId: input.session.id,
    cwd: input.session.cwd,
    runDirectory: input.runtime.getStorage().runDirectory,
    config: input.config,
    eventBus: input.eventBus,
    security: input.services.security,
    approvals: input.services.approvals,
    sandbox: input.services.sandbox,
    nonInteractive: input.nonInteractive
  };
}

async function runLifecycleHooks(input: {
  point: HookPoint;
  session: NexusSession;
  config: ResolvedConfig;
  eventBus: InMemoryEventBus;
  services: RuntimeServices;
  runtime: NexusRuntime;
  nonInteractive: boolean;
}): Promise<void> {
  await input.services.hooks.run({
    cwd: input.session.cwd,
    sessionId: input.session.id,
    point: input.point,
    tools: input.services.tools,
    ctx: createRollbackContext({
      session: input.session,
      config: input.config,
      eventBus: input.eventBus,
      services: input.services,
      runtime: input.runtime,
      nonInteractive: input.nonInteractive
    })
  });
}

function packageCommandFallback(packageManager: string, script: string): string {
  if (packageManager === "pnpm") {
    return `pnpm ${script}`;
  }
  if (packageManager === "yarn") {
    return `yarn ${script}`;
  }
  return `npm run ${script}`;
}

async function renderMcpStatus(cwd: string): Promise<string> {
  const servers = await new McpRegistry().list(cwd);
  if (servers.length === 0) {
    return "No MCP servers configured.";
  }
  return servers
    .map((server) => `${server.id} ${server.enabled ? "enabled" : "disabled"} ${server.transport}`)
    .join("\n");
}

async function renderSkillsStatus(cwd: string): Promise<string> {
  const skills = await new SkillRegistry().summaries(cwd);
  return (
    skills.map((skill) => `${skill.id}: ${skill.description}`).join("\n") || "No skills available."
  );
}

async function renderHooksStatus(cwd: string): Promise<string> {
  const hooks = await new HookRegistry().list(cwd);
  if (hooks.length === 0) {
    return "No hooks configured.";
  }
  return hooks
    .map((hook) => `${hook.id} ${hook.enabled ? "enabled" : "disabled"} ${hook.event}`)
    .join("\n");
}

async function renderAgentStatus(input: {
  argument: string | undefined;
  session: NexusSession;
  config: ResolvedConfig;
  runtime: NexusRuntime;
  services: RuntimeServices;
  eventBus: InMemoryEventBus;
  nonInteractive: boolean;
}): Promise<string> {
  const prompt = input.argument?.trim() || "Summarize the current workspace task.";
  const result = await new SubagentManager().run({
    name: input.argument?.trim() || "Explorer Agent",
    role: "explorer",
    prompt,
    permissionProfile: "read-only",
    session: input.session,
    runtimeContext: createRuntimeContext(input)
  });
  return `${result.name} ${result.status}: ${result.summary}`;
}

function createRuntimeContext(input: {
  session: NexusSession;
  config: ResolvedConfig;
  runtime: NexusRuntime;
  services: RuntimeServices;
  eventBus: InMemoryEventBus;
  nonInteractive: boolean;
}): RuntimeContext {
  return {
    session: input.session,
    config: input.config,
    eventBus: input.eventBus,
    storage: input.runtime.getStorage(),
    services: input.services,
    nonInteractive: input.nonInteractive
  };
}

async function renderUtilityIntentMessage(input: {
  intent: RuntimeIntent;
  config: ResolvedConfig;
  session: NexusSession;
  runtime: NexusRuntime;
  services: RuntimeServices;
}): Promise<string | undefined> {
  switch (input.intent.type) {
    case "model.fast":
      return "Fast model target: deepseek/deepseek-v4-flash. Start a new session with --model-provider deepseek --model deepseek-v4-flash to switch.";
    case "theme.show":
      return "Theme: default.";
    case "statusline.show":
      return `Status line: ${input.config.tui.statusLineItems.join(", ") || "disabled"}.`;
    case "raw.show":
      return `Raw event log: ${input.session.eventLogPath}`;
    case "copy.last":
      return `Last answer artifact: ${input.runtime.getStorage().artifacts.finalAnswerPath}`;
    case "mention.add":
      return input.intent.argument
        ? `Mention ready for next prompt: ${input.intent.argument}`
        : "Usage: /mention <path-or-symbol>";
    case "project.init":
      return initializeProject(input.session.cwd);
    case "session.side":
      return "Side sessions use /fork in this terminal build; the fork preserves parent session metadata.";
    case "apps.open":
      return "Apps are available through configured MCP/app connectors.";
    case "plugins.open":
      return `Plugins enabled: ${input.config.features.plugins ? "yes" : "no"}.`;
    case "experimental.open":
      return `Experimental features: hooks=${input.config.features.hooks ? "on" : "off"}, mcp=${input.config.features.mcp ? "on" : "off"}, subagents=${input.config.features.subagents ? "on" : "off"}.`;
    case "sandbox.add_read_dir":
      return input.intent.argument
        ? `Sandbox read directory requested for this session: ${input.intent.argument}`
        : "Usage: /sandbox-add-read-dir <path>";
    case "keymap.show":
      return "Keymap: Enter submit, Esc clear composer, Ctrl+C quit.";
    case "vim.toggle":
      return "Vim mode is a TUI preference; no persistent toggle is configured in this build.";
    default:
      return undefined;
  }
}

async function initializeProject(cwd: string): Promise<string> {
  await mkdir(`${cwd}/.nexus`, { recursive: true });
  const configPath = `${cwd}/.nexus/config.toml`;
  const agentsPath = `${cwd}/AGENTS.md`;
  const created: string[] = [];
  if (!(await fileExists(configPath))) {
    await writeFile(
      configPath,
      [
        'model_provider = "deepseek"',
        'model = "deepseek-v4-flash"',
        "",
        "[sdlc]",
        "require_plan_for_large_changes = true",
        "require_verification = true",
        "require_review_for_security_sensitive_changes = true",
        ""
      ].join("\n"),
      "utf8"
    );
    created.push(".nexus/config.toml");
  }
  if (!(await fileExists(agentsPath))) {
    await writeFile(
      agentsPath,
      [
        "# Project Instructions",
        "",
        "- Keep edits scoped to the requested task.",
        "- Run relevant verification before finalizing code changes.",
        "- Do not commit secrets or API keys.",
        ""
      ].join("\n"),
      "utf8"
    );
    created.push("AGENTS.md");
  }
  return created.length > 0
    ? `Initialized project files: ${created.join(", ")}`
    : "Project already initialized.";
}

async function fileExists(path: string): Promise<boolean> {
  return Boolean(
    await readFile(path, "utf8")
      .then(() => true)
      .catch(() => false)
  );
}

async function handleSdlcGoalCommand(input: {
  session: NexusSession;
  config: ResolvedConfig;
  runtime: NexusRuntime;
  services: RuntimeServices;
  eventBus: InMemoryEventBus;
  sdlcManager: SdlcManager;
  goal: string;
}): Promise<string> {
  const context = await input.services.context.compile({
    cwd: input.session.cwd,
    config: input.config,
    prompt: input.goal
  });
  await input.sdlcManager.discover({
    sessionId: input.session.id,
    eventBus: input.eventBus,
    context
  });
  await input.sdlcManager.setGoal({
    sessionId: input.session.id,
    eventBus: input.eventBus,
    goal: input.goal,
    createdAt: nowIso()
  });
  await persistContextArtifact(input.runtime, context);
  await persistSdlcManifest(input.runtime, input.sdlcManager);
  return `Goal set: ${input.goal}`;
}

async function handleSdlcPlanCommand(input: {
  session: NexusSession;
  config: ResolvedConfig;
  runtime: NexusRuntime;
  services: RuntimeServices;
  eventBus: InMemoryEventBus;
  sdlcManager: SdlcManager;
  prompt?: string;
}): Promise<string> {
  const context = await input.services.context.compile({
    cwd: input.session.cwd,
    config: input.config,
    ...(input.prompt ? { prompt: input.prompt } : {})
  });
  await runLifecycleHooks({
    point: "before_plan",
    session: input.session,
    config: input.config,
    eventBus: input.eventBus,
    services: input.services,
    runtime: input.runtime,
    nonInteractive: false
  });
  const modelPlan = await createModelPlanSuggestion({
    session: input.session,
    config: input.config,
    services: input.services,
    eventBus: input.eventBus,
    context,
    ...(input.prompt ? { prompt: input.prompt } : {})
  });
  const plan = await input.sdlcManager.createPlan({
    sessionId: input.session.id,
    eventBus: input.eventBus,
    context,
    ...(input.prompt ? { prompt: input.prompt } : {}),
    ...(modelPlan ? { modelPlan } : {})
  });
  const storage = input.runtime.getStorage();
  await storage.writeArtifact("planPath", safeJsonStringify(plan));
  await persistContextArtifact(input.runtime, context);
  await persistSdlcManifest(input.runtime, input.sdlcManager);
  await runLifecycleHooks({
    point: "after_plan",
    session: input.session,
    config: input.config,
    eventBus: input.eventBus,
    services: input.services,
    runtime: input.runtime,
    nonInteractive: false
  });
  return `Plan ready: ${plan.steps.length} step(s), ${plan.verification.length} verification command(s), source ${plan.source}.`;
}

async function handleSdlcVerifyCommand(input: {
  session: NexusSession;
  config: ResolvedConfig;
  runtime: NexusRuntime;
  services: RuntimeServices;
  eventBus: InMemoryEventBus;
  sdlcManager: SdlcManager;
  sessionCommandsRun: Set<string>;
  command?: string;
}): Promise<string> {
  const state = input.sdlcManager.getState();
  const command = input.command || state.plan?.verification[0]?.command;
  const required =
    state.plan?.verification.find((item) => item.command === command)?.required ?? true;
  if (!command) {
    const report = await input.sdlcManager.verify({
      sessionId: input.session.id,
      eventBus: input.eventBus,
      status: "skipped",
      summary: "No verification command is available.",
      required: false
    });
    await input.runtime.getStorage().writeArtifact("verificationPath", safeJsonStringify(report));
    await persistSdlcManifest(input.runtime, input.sdlcManager, {
      verificationStatus: report.status
    });
    return "Verification skipped: no command is available.";
  }

  await runLifecycleHooks({
    point: "before_verify",
    session: input.session,
    config: input.config,
    eventBus: input.eventBus,
    services: input.services,
    runtime: input.runtime,
    nonInteractive: false
  });
  const result = await runVerificationCommand({
    session: input.session,
    config: input.config,
    eventBus: input.eventBus,
    services: input.services,
    command
  });
  for (const item of result.commandsRun) {
    input.sessionCommandsRun.add(item);
  }
  const report = await input.sdlcManager.verify({
    sessionId: input.session.id,
    eventBus: input.eventBus,
    command,
    status: result.passed ? "passed" : "failed",
    summary: result.summary,
    required
  });
  await input.runtime.getStorage().writeArtifact("verificationPath", safeJsonStringify(report));
  await persistSdlcManifest(input.runtime, input.sdlcManager, {
    verificationStatus: report.status
  });
  await runLifecycleHooks({
    point: "after_verify",
    session: input.session,
    config: input.config,
    eventBus: input.eventBus,
    services: input.services,
    runtime: input.runtime,
    nonInteractive: false
  });
  return `Verification ${report.status}: ${report.summary}`;
}

async function handleSdlcReviewCommand(input: {
  session: NexusSession;
  config: ResolvedConfig;
  runtime: NexusRuntime;
  services: RuntimeServices;
  eventBus: InMemoryEventBus;
  sdlcManager: SdlcManager;
  filesChanged: string[];
  diff?: string;
}): Promise<string> {
  const context = await input.services.context.compile({
    cwd: input.session.cwd,
    config: input.config
  });
  const diff = input.diff ?? context.repository.git.diff;
  const eventDiff = await readRecordedDiff(input.runtime);
  const effectiveDiff = diff || eventDiff;
  const filesChanged =
    input.filesChanged.length > 0
      ? input.filesChanged
      : filesChangedFromGitStatus(context.repository.git.status);
  await runLifecycleHooks({
    point: "before_review",
    session: input.session,
    config: input.config,
    eventBus: input.eventBus,
    services: input.services,
    runtime: input.runtime,
    nonInteractive: false
  });
  const modelFindings = await createModelReviewFindings({
    session: input.session,
    config: input.config,
    services: input.services,
    eventBus: input.eventBus,
    context,
    filesChanged,
    diff: effectiveDiff
  });
  const review = await input.sdlcManager.review({
    sessionId: input.session.id,
    eventBus: input.eventBus,
    filesChanged,
    ...(effectiveDiff ? { diff: effectiveDiff } : {}),
    ...(modelFindings.length > 0 ? { modelFindings } : {})
  });
  await input.runtime.getStorage().writeArtifact("reviewPath", safeJsonStringify(review));
  if (effectiveDiff) {
    await input.runtime.getStorage().writeArtifact("diffPatchPath", effectiveDiff);
  }
  await persistContextArtifact(input.runtime, context);
  await persistSdlcManifest(input.runtime, input.sdlcManager, { reviewStatus: review.status });
  await runLifecycleHooks({
    point: "after_review",
    session: input.session,
    config: input.config,
    eventBus: input.eventBus,
    services: input.services,
    runtime: input.runtime,
    nonInteractive: false
  });
  return `Review ${review.status}: ${review.summary}`;
}

async function handleShipCommand(input: {
  session: NexusSession;
  eventBus: InMemoryEventBus;
  runtime: NexusRuntime;
  sdlcManager: SdlcManager;
  filesChanged: string[];
  commandsRun: string[];
}): Promise<string> {
  const eventDiff = await readRecordedDiff(input.runtime);
  if (eventDiff) {
    await input.runtime.getStorage().writeArtifact("diffPatchPath", eventDiff);
  }
  const artifact = await input.sdlcManager.ship({
    sessionId: input.session.id,
    eventBus: input.eventBus,
    filesChanged: input.filesChanged,
    commandsRun: input.commandsRun,
    rollbackNote:
      "Use the session rollback artifact or the recorded diff patch to revert this release candidate."
  });
  await input.runtime.getStorage().writeArtifact(
    "shipPath",
    safeJsonStringify({
      ...artifact,
      eventLogPath: input.session.eventLogPath,
      diffPatchPath: eventDiff ? input.runtime.getStorage().artifacts.diffPatchPath : ""
    })
  );
  await persistSdlcManifest(input.runtime, input.sdlcManager, {
    ...(artifact.verificationStatus !== "missing"
      ? { verificationStatus: artifact.verificationStatus }
      : {}),
    ...(artifact.reviewStatus !== "missing" ? { reviewStatus: artifact.reviewStatus } : {})
  });
  return `${artifact.status === "ready" ? "Ship ready" : "Ship blocked"}: ${artifact.summary}\nArtifact: ${
    input.runtime.getStorage().artifacts.shipPath
  }`;
}

async function handleContextCompactCommand(input: {
  session: NexusSession;
  config: ResolvedConfig;
  runtime: NexusRuntime;
  services: RuntimeServices;
  eventBus: InMemoryEventBus;
  sdlcManager: SdlcManager;
  learningPlane: LearningPlane;
  commandsRun: string[];
  filesChanged: string[];
}): Promise<string> {
  const context = await input.services.context.compile({
    cwd: input.session.cwd,
    config: input.config
  });
  const semanticCandidates = await createModelLearningCandidates({
    session: input.session,
    config: input.config,
    services: input.services,
    eventBus: input.eventBus,
    context,
    commandsRun: input.commandsRun,
    filesChanged: input.filesChanged
  });
  const candidates = await input.learningPlane.generateCandidates({
    sessionId: input.session.id,
    eventBus: input.eventBus,
    context,
    commandsRun: input.commandsRun,
    filesChanged: input.filesChanged,
    ...(semanticCandidates.length > 0 ? { semanticCandidates } : {})
  });
  await input.sdlcManager.learn({
    sessionId: input.session.id,
    eventBus: input.eventBus,
    candidateCount: candidates.length
  });
  const storage = input.runtime.getStorage();
  await persistContextArtifact(input.runtime, context);
  await storage.writeArtifact(
    "learningCandidatesPath",
    safeJsonStringify({
      mode: input.learningPlane.getState().mode,
      effectiveMode: input.learningPlane.getState().effectiveMode,
      candidates
    })
  );
  await persistSdlcManifest(input.runtime, input.sdlcManager, {
    learningCandidateCount: candidates.length
  });
  return `Compacted context into ${candidates.length} memory candidate(s).`;
}

async function createModelPlanSuggestion(input: {
  session: NexusSession;
  config: ResolvedConfig;
  services: RuntimeServices;
  eventBus: InMemoryEventBus;
  context: CompiledContext;
  prompt?: string;
}): Promise<ModelPlanSuggestion | undefined> {
  if (input.config.modelProvider === "fake") {
    return undefined;
  }
  try {
    const result = await input.services.models.call({
      providerId: input.config.modelProvider,
      sessionId: input.session.id,
      model: input.config.model,
      eventBus: input.eventBus,
      context: input.context,
      messages: [
        {
          role: "system",
          content:
            "Return only compact JSON for an SDLC implementation plan with keys summary, steps, risks, verification, approvalRequirements, files."
        },
        {
          role: "user",
          content: safeJsonStringify({
            goal: input.prompt ?? "Complete the current coding task",
            context: input.context.compactSummary,
            testCommands: input.context.repository.testCommands,
            filesMentioned: input.context.mentions
          })
        }
      ]
    });
    return normalizeModelPlanSuggestion(extractJsonObject(result.message));
  } catch {
    return undefined;
  }
}

async function createModelReviewFindings(input: {
  session: NexusSession;
  config: ResolvedConfig;
  services: RuntimeServices;
  eventBus: InMemoryEventBus;
  context: CompiledContext;
  filesChanged: string[];
  diff: string;
}): Promise<ReviewFinding[]> {
  if (input.config.modelProvider === "fake" || !input.diff.trim()) {
    return [];
  }
  try {
    const result = await input.services.models.call({
      providerId: input.config.modelProvider,
      sessionId: input.session.id,
      model: input.config.model,
      eventBus: input.eventBus,
      context: input.context,
      messages: [
        {
          role: "system",
          content:
            "Return only compact JSON with a findings array. Each finding has severity, title, description, optional file, line, recommendation, category."
        },
        {
          role: "user",
          content: safeJsonStringify({
            filesChanged: input.filesChanged,
            diff: input.diff.slice(0, 12000),
            context: input.context.compactSummary
          })
        }
      ]
    });
    return normalizeModelReviewFindings(extractJsonObject(result.message));
  } catch {
    return [];
  }
}

async function createModelLearningCandidates(input: {
  session: NexusSession;
  config: ResolvedConfig;
  services: RuntimeServices;
  eventBus: InMemoryEventBus;
  context: CompiledContext;
  commandsRun: string[];
  filesChanged: string[];
}): Promise<LearningCandidateDraft[]> {
  if (input.config.modelProvider === "fake") {
    return [];
  }
  try {
    const result = await input.services.models.call({
      providerId: input.config.modelProvider,
      sessionId: input.session.id,
      model: input.config.model,
      eventBus: input.eventBus,
      context: input.context,
      messages: [
        {
          role: "system",
          content:
            "Return only compact JSON with a candidates array. Each candidate has scope, type, text, and confidence. Create durable repo/user habits, test maps, workflows, or known failures only; never include secrets or raw credentials."
        },
        {
          role: "user",
          content: safeJsonStringify({
            compactSummary: input.context.compactSummary,
            commandsRun: input.commandsRun,
            filesChanged: input.filesChanged,
            testCommands: input.context.repository.testCommands,
            packageScripts: input.context.repository.packageScripts,
            existingProjectMemory: input.context.memories.project.slice(0, 4000),
            existingUserMemory: input.context.memories.user.slice(0, 2000)
          })
        }
      ]
    });
    return normalizeModelLearningCandidates(extractJsonObject(result.message));
  } catch {
    return [];
  }
}

async function persistContextArtifact(
  runtime: NexusRuntime,
  context: CompiledContext
): Promise<void> {
  await runtime.getStorage().writeArtifact(
    "contextSummaryPath",
    safeJsonStringify({
      cwd: context.cwd,
      model: context.model,
      modelProvider: context.modelProvider,
      repository: {
        repoRoot: context.repository.repoRoot,
        packageManager: context.repository.packageManager,
        topLevelFiles: context.repository.topLevelFiles,
        packageScripts: context.repository.packageScripts,
        testCommands: context.repository.testCommands,
        git: {
          available: context.repository.git.available,
          branch: context.repository.git.branch,
          statusLineCount: context.repository.git.status
            .split(/\r?\n/)
            .filter((line) => line.trim()).length,
          diffBytes: Buffer.byteLength(context.repository.git.diff, "utf8")
        },
        repoMap: {
          fileCount: context.repository.repoMap.files.length,
          directories: context.repository.repoMap.directories,
          truncated: context.repository.repoMap.truncated
        }
      },
      mentions: context.mentions,
      memories: {
        projectPath: context.memories.paths.project,
        userPath: context.memories.paths.user,
        projectPresent: context.memories.project.trim().length > 0,
        userPresent: context.memories.user.trim().length > 0
      },
      tokenBudget: context.tokenBudget,
      compactSummary: context.compactSummary,
      promptInjectionFindingCount: context.security.promptInjectionFindings.length
    })
  );
}

async function persistSdlcManifest(
  runtime: NexusRuntime,
  sdlcManager: SdlcManager,
  patch: {
    verificationStatus?: "passed" | "failed" | "skipped";
    reviewStatus?: "passed" | "warnings" | "failed";
    learningCandidateCount?: number;
  } = {}
): Promise<void> {
  const storage = runtime.getStorage();
  const current = await storage.readManifest();
  const state = sdlcManager.getState();
  const next = {
    ...current,
    artifacts: storage.artifacts,
    sdlcStages: state.stageRuns.map((run) => `${run.stage}:${run.status}`),
    ...(state.verification ? { verificationStatus: state.verification.status } : {}),
    ...(state.review ? { reviewStatus: state.review.status } : {}),
    ...patch
  };
  await storage.writeManifest(next);
}

function normalizeModelPlanSuggestion(value: unknown): ModelPlanSuggestion | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return {
    ...(typeof value.summary === "string" ? { summary: value.summary } : {}),
    steps: readJsonStringArray(value.steps),
    risks: readJsonArray(value.risks)
      .map((risk) => {
        if (!isRecord(risk) || typeof risk.text !== "string") {
          return undefined;
        }
        const severity =
          risk.severity === "low" || risk.severity === "medium" || risk.severity === "high"
            ? risk.severity
            : undefined;
        return {
          text: risk.text,
          ...(severity ? { severity } : {})
        };
      })
      .filter((risk): risk is { text: string; severity?: "low" | "medium" | "high" } =>
        Boolean(risk)
      ),
    verification: readJsonArray(value.verification)
      .map((item) => {
        if (typeof item === "string") {
          return { command: item };
        }
        if (!isRecord(item) || typeof item.command !== "string") {
          return undefined;
        }
        return {
          command: item.command,
          ...(typeof item.required === "boolean" ? { required: item.required } : {}),
          ...(typeof item.reason === "string" ? { reason: item.reason } : {})
        };
      })
      .filter((item): item is { command: string; required?: boolean; reason?: string } =>
        Boolean(item)
      ),
    approvalRequirements: readJsonStringArray(value.approvalRequirements),
    files: readJsonStringArray(value.files)
  };
}

function normalizeModelReviewFindings(value: unknown): ReviewFinding[] {
  const findings = isRecord(value) ? readJsonArray(value.findings) : [];
  return findings
    .map((item, index): ReviewFinding | undefined => {
      if (
        !isRecord(item) ||
        typeof item.title !== "string" ||
        typeof item.description !== "string"
      ) {
        return undefined;
      }
      const severity = normalizeSeverity(item.severity);
      const category = normalizeReviewCategory(item.category);
      const finding: ReviewFinding = {
        id: `finding_model_${index + 1}`,
        severity,
        title: item.title,
        description: item.description
      };
      if (typeof item.file === "string") {
        finding.file = item.file;
      }
      if (typeof item.line === "number") {
        finding.line = item.line;
      }
      if (typeof item.recommendation === "string") {
        finding.recommendation = item.recommendation;
      }
      if (category) {
        finding.category = category;
      }
      return finding;
    })
    .filter((finding): finding is ReviewFinding => Boolean(finding));
}

function normalizeModelLearningCandidates(value: unknown): LearningCandidateDraft[] {
  const candidates = isRecord(value) ? readJsonArray(value.candidates) : [];
  return candidates
    .map((item) => {
      if (!isRecord(item) || typeof item.text !== "string" || !item.text.trim()) {
        return undefined;
      }
      const scope = normalizeLearningScope(item.scope);
      const type = normalizeLearningType(item.type);
      const confidence = typeof item.confidence === "number" ? item.confidence : undefined;
      return {
        ...(scope ? { scope } : {}),
        ...(type ? { type } : {}),
        text: item.text,
        ...(confidence !== undefined ? { confidence } : {})
      };
    })
    .filter((candidate): candidate is LearningCandidateDraft => Boolean(candidate));
}

function extractJsonObject(text: string): unknown {
  const withoutFence = text
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    return JSON.parse(withoutFence) as unknown;
  } catch {
    const start = withoutFence.indexOf("{");
    const end = withoutFence.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(withoutFence.slice(start, end + 1)) as unknown;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

function filesChangedFromGitStatus(status: string): string[] {
  return status
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0 && !line.startsWith("## "))
    .map((line) => line.slice(3).trim())
    .filter((line) => line.length > 0);
}

function readJsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readJsonStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function normalizeSeverity(value: unknown): ReviewFinding["severity"] {
  if (
    value === "critical" ||
    value === "high" ||
    value === "medium" ||
    value === "low" ||
    value === "info"
  ) {
    return value;
  }
  return "medium";
}

function normalizeReviewCategory(value: unknown): ReviewFinding["category"] | undefined {
  if (
    value === "correctness" ||
    value === "security" ||
    value === "testing" ||
    value === "maintainability" ||
    value === "process"
  ) {
    return value;
  }
  return undefined;
}

function normalizeLearningScope(value: unknown): LearningCandidateDraft["scope"] | undefined {
  if (value === "project" || value === "user" || value === "session") {
    return value;
  }
  return undefined;
}

function normalizeLearningType(value: unknown): LearningCandidateDraft["type"] | undefined {
  if (
    value === "workflow" ||
    value === "test-map" ||
    value === "preference" ||
    value === "known-failure" ||
    value === "project-fact"
  ) {
    return value;
  }
  return undefined;
}

async function handleMemoriesIntent(input: {
  session: NexusSession;
  eventBus: InMemoryEventBus;
  learningPlane: LearningPlane;
  action?: string;
}): Promise<void> {
  const action = input.action?.trim().toLowerCase() ?? "";
  const parts = action.split(/\s+/).filter(Boolean);
  if (parts[0] === "accept") {
    const candidateIds =
      parts[1] && parts[1] !== "all" ? [parts[1] as LearningCandidateId] : undefined;
    const entries = await input.learningPlane.acceptPending({
      sessionId: input.session.id,
      eventBus: input.eventBus,
      cwd: input.session.cwd,
      ...(candidateIds ? { candidateIds } : {})
    });
    output.write(`Accepted ${entries.length} memory entr${entries.length === 1 ? "y" : "ies"}.\n`);
    return;
  }
  if (parts[0] === "reject") {
    const candidateIds =
      parts[1] && parts[1] !== "all" ? [parts[1] as LearningCandidateId] : undefined;
    const rejected = await input.learningPlane.rejectPending({
      sessionId: input.session.id,
      eventBus: input.eventBus,
      ...(candidateIds ? { candidateIds } : {})
    });
    output.write(`Rejected ${rejected.length} memory candidate(s).\n`);
    return;
  }
  if (parts[0] === "edit-candidate" && parts[1] && parts.length > 2) {
    const edited = await input.learningPlane.editCandidate({
      candidateId: parts[1] as LearningCandidateId,
      text: input.action?.split(/\s+/).slice(2).join(" ") ?? ""
    });
    output.write(edited ? `Edited candidate ${edited.id}.\n` : "Memory candidate was not found.\n");
    return;
  }
  if (parts[0] === "edit-memory" && parts[1] && parts.length > 2) {
    const edited = await input.learningPlane.editMemory({
      sessionId: input.session.id,
      eventBus: input.eventBus,
      cwd: input.session.cwd,
      memoryId: parts[1] as MemoryId,
      text: input.action?.split(/\s+/).slice(2).join(" ") ?? ""
    });
    output.write(edited ? `Edited memory ${edited.id}.\n` : "Memory entry was not found.\n");
    return;
  }
  if (parts[0] === "delete" && parts[1]) {
    const deleted = await input.learningPlane.deleteMemory({
      sessionId: input.session.id,
      eventBus: input.eventBus,
      cwd: input.session.cwd,
      memoryId: parts[1] as MemoryId
    });
    output.write(deleted ? `Deleted memory ${deleted.id}.\n` : "Memory entry was not found.\n");
    return;
  }
  if (parts[0] === "export") {
    output.write(
      `${safeJsonStringify(await input.learningPlane.listMemories(input.session.cwd))}\n`
    );
    return;
  }
  if (parts[0] === "audit") {
    const state = input.learningPlane.getState();
    const memories = await input.learningPlane.listMemories(input.session.cwd);
    output.write(
      [
        `Accepted memories: ${memories.length}`,
        `Pending candidates: ${state.pendingCandidates.length}`,
        `Sensitive pending candidates: ${state.pendingCandidates.filter((candidate) => candidate.sensitive).length}`
      ].join("\n") + "\n"
    );
    return;
  }

  const state = input.learningPlane.getState();
  const memories = await input.learningPlane.listMemories(input.session.cwd);
  output.write(`Pending memory candidates: ${state.pendingCandidates.length}\n`);
  for (const candidate of state.pendingCandidates) {
    output.write(`- ${candidate.id} [${candidate.scope}/${candidate.type}] ${candidate.text}\n`);
  }
  output.write(`Accepted memories: ${memories.length}\n`);
  for (const memory of memories) {
    output.write(`- ${memory.id} [${memory.scope}/${memory.type}] ${memory.text}\n`);
  }
}

async function handleMemoriesIntentForMessage(input: {
  session: NexusSession;
  eventBus: InMemoryEventBus;
  learningPlane: LearningPlane;
  action?: string;
}): Promise<string> {
  const action = input.action?.trim().toLowerCase() ?? "";
  const parts = action.split(/\s+/).filter(Boolean);
  if (parts[0] === "accept") {
    const candidateIds =
      parts[1] && parts[1] !== "all" ? [parts[1] as LearningCandidateId] : undefined;
    const entries = await input.learningPlane.acceptPending({
      sessionId: input.session.id,
      eventBus: input.eventBus,
      cwd: input.session.cwd,
      ...(candidateIds ? { candidateIds } : {})
    });
    return `Accepted ${entries.length} memory entr${entries.length === 1 ? "y" : "ies"}.`;
  }
  if (parts[0] === "reject") {
    const candidateIds =
      parts[1] && parts[1] !== "all" ? [parts[1] as LearningCandidateId] : undefined;
    const rejected = await input.learningPlane.rejectPending({
      sessionId: input.session.id,
      eventBus: input.eventBus,
      ...(candidateIds ? { candidateIds } : {})
    });
    return `Rejected ${rejected.length} memory candidate(s).`;
  }
  if (parts[0] === "edit-candidate" && parts[1] && parts.length > 2) {
    const edited = await input.learningPlane.editCandidate({
      candidateId: parts[1] as LearningCandidateId,
      text: input.action?.split(/\s+/).slice(2).join(" ") ?? ""
    });
    return edited ? `Edited candidate ${edited.id}.` : "Memory candidate was not found.";
  }
  if (parts[0] === "edit-memory" && parts[1] && parts.length > 2) {
    const edited = await input.learningPlane.editMemory({
      sessionId: input.session.id,
      eventBus: input.eventBus,
      cwd: input.session.cwd,
      memoryId: parts[1] as MemoryId,
      text: input.action?.split(/\s+/).slice(2).join(" ") ?? ""
    });
    return edited ? `Edited memory ${edited.id}.` : "Memory entry was not found.";
  }
  if (parts[0] === "delete" && parts[1]) {
    const deleted = await input.learningPlane.deleteMemory({
      sessionId: input.session.id,
      eventBus: input.eventBus,
      cwd: input.session.cwd,
      memoryId: parts[1] as MemoryId
    });
    return deleted ? `Deleted memory ${deleted.id}.` : "Memory entry was not found.";
  }
  if (parts[0] === "export") {
    return safeJsonStringify(await input.learningPlane.listMemories(input.session.cwd));
  }
  if (parts[0] === "audit") {
    const state = input.learningPlane.getState();
    const memories = await input.learningPlane.listMemories(input.session.cwd);
    return [
      `Accepted memories: ${memories.length}`,
      `Pending candidates: ${state.pendingCandidates.length}`,
      `Sensitive pending candidates: ${state.pendingCandidates.filter((candidate) => candidate.sensitive).length}`
    ].join("\n");
  }

  const state = input.learningPlane.getState();
  const memories = await input.learningPlane.listMemories(input.session.cwd);
  const lines = [`Pending memory candidates: ${state.pendingCandidates.length}`];
  for (const candidate of state.pendingCandidates) {
    lines.push(`- ${candidate.id} [${candidate.scope}/${candidate.type}] ${candidate.text}`);
  }
  lines.push(`Accepted memories: ${memories.length}`);
  for (const memory of memories) {
    lines.push(`- ${memory.id} [${memory.scope}/${memory.type}] ${memory.text}`);
  }
  return lines.join("\n");
}

function recordTurnResult(
  result: TurnResult,
  filesChanged: Set<string>,
  commandsRun: Set<string>
): void {
  for (const file of result.filesChanged) {
    filesChanged.add(file);
  }
  for (const command of result.commandsRun) {
    commandsRun.add(command);
  }
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function readOutputStatus(outputValue: unknown): string | undefined {
  if (typeof outputValue === "object" && outputValue !== null && "status" in outputValue) {
    const status = (outputValue as { status: unknown }).status;
    return typeof status === "string" ? status : undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type ParsedCommand =
  | "exec"
  | "help"
  | "version"
  | "interactive"
  | "resume"
  | "fork"
  | "login"
  | "logout"
  | "mcp"
  | "skills"
  | "hooks"
  | "utility";

interface ParsedArgs {
  command: ParsedCommand;
  prompt?: string;
  json: boolean;
  cwd?: string;
  configPath?: string;
  overrides: ConfigOverrides;
  utilityCommand?: string;
  authProvider?: string;
  authApiKey?: string;
  authFile?: string;
  authOrganization?: string;
  authProject?: string;
  authAll?: boolean;
  image?: string;
  oss?: boolean;
  search?: boolean;
  noAltScreen?: boolean;
  verify?: string;
  rollbackOnVerifyFail?: boolean;
  allowMutations?: boolean;
  outputPath?: string;
  patchPath?: string;
  reportPath?: string;
  eventsPath?: string;
  reviewReportPath?: string;
  learningCandidatesPath?: string;
}

function parseArgs(args: string[]): ParsedArgs {
  if (args.includes("--help") || args.includes("-h")) {
    return { command: "help", json: false, overrides: {} };
  }

  if (args.includes("--version") || args.includes("-V")) {
    return { command: "version", json: false, overrides: {} };
  }

  const parseState: ParsedArgs = {
    command: "interactive",
    json: false,
    overrides: {}
  };
  const promptParts: string[] = [];
  let commandSelected = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) {
      continue;
    }

    if (!commandSelected && isKnownCommand(arg)) {
      commandSelected = true;
      parseState.command =
        arg === "exec" ||
        arg === "resume" ||
        arg === "fork" ||
        arg === "login" ||
        arg === "logout" ||
        arg === "mcp" ||
        arg === "skills" ||
        arg === "hooks"
          ? arg
          : "utility";
      if (parseState.command === "utility") {
        parseState.utilityCommand = arg;
      }
      continue;
    }

    if (arg === "--json") {
      parseState.json = true;
      continue;
    }

    if (arg === "--last") {
      continue;
    }

    if (arg === "--model" || arg === "-m") {
      parseState.overrides.model = readFlagValue(args, (index += 1), arg);
      continue;
    }

    if (arg === "--model-provider") {
      parseState.overrides.modelProvider = readFlagValue(args, (index += 1), arg);
      continue;
    }

    if (arg === "--profile" || arg === "-p") {
      parseState.overrides.profile = readFlagValue(args, (index += 1), arg);
      continue;
    }

    if (arg === "--cd" || arg === "-C") {
      parseState.cwd = readFlagValue(args, (index += 1), arg);
      continue;
    }

    if (arg === "--config" || arg === "-c") {
      parseState.configPath = readFlagValue(args, (index += 1), arg);
      continue;
    }

    if (arg === "--provider") {
      parseState.authProvider = readFlagValue(args, (index += 1), arg);
      continue;
    }

    if (arg === "--api-key") {
      parseState.authApiKey = readFlagValue(args, (index += 1), arg);
      continue;
    }

    if (arg === "--auth-file") {
      parseState.authFile = readFlagValue(args, (index += 1), arg);
      continue;
    }

    if (arg === "--organization") {
      parseState.authOrganization = readFlagValue(args, (index += 1), arg);
      continue;
    }

    if (arg === "--project") {
      parseState.authProject = readFlagValue(args, (index += 1), arg);
      continue;
    }

    if (arg === "--all") {
      parseState.authAll = true;
      continue;
    }

    if (arg === "--sandbox") {
      parseState.overrides.sandboxMode = parseSandboxMode(readFlagValue(args, (index += 1), arg));
      continue;
    }

    if (arg === "--ask-for-approval") {
      parseState.overrides.approvalPolicy = parseApprovalPolicy(
        readFlagValue(args, (index += 1), arg)
      );
      continue;
    }

    if (arg === "--image") {
      parseState.image = readFlagValue(args, (index += 1), arg);
      continue;
    }

    if (arg === "--oss") {
      parseState.oss = true;
      continue;
    }

    if (arg === "--search") {
      parseState.search = true;
      continue;
    }

    if (arg === "--no-alt-screen") {
      parseState.noAltScreen = true;
      continue;
    }

    if (arg === "--verify") {
      parseState.verify = readFlagValue(args, (index += 1), arg);
      continue;
    }

    if (arg === "--rollback-on-verify-fail") {
      parseState.rollbackOnVerifyFail = true;
      continue;
    }

    if (arg === "--allow-mutations") {
      parseState.allowMutations = true;
      parseState.overrides.sandboxMode ??= "workspace-write";
      parseState.overrides.approvalPolicy ??= "never";
      continue;
    }

    if (arg === "--output") {
      parseState.outputPath = readFlagValue(args, (index += 1), arg);
      continue;
    }

    if (arg === "--patch") {
      parseState.patchPath = readFlagValue(args, (index += 1), arg);
      continue;
    }

    if (arg === "--report") {
      parseState.reportPath = readFlagValue(args, (index += 1), arg);
      continue;
    }

    if (arg === "--events") {
      parseState.eventsPath = readFlagValue(args, (index += 1), arg);
      continue;
    }

    if (arg === "--review-report") {
      parseState.reviewReportPath = readFlagValue(args, (index += 1), arg);
      continue;
    }

    if (arg === "--learning-candidates") {
      parseState.learningCandidatesPath = readFlagValue(args, (index += 1), arg);
      continue;
    }

    if (arg.startsWith("--")) {
      throw new NexusError({
        category: "config",
        message: `Unknown flag '${arg}'.`,
        recoverable: true
      });
    }

    promptParts.push(arg);
  }

  parseState.prompt = promptParts.join(" ");
  return parseState;
}

function isKnownCommand(value: string): boolean {
  return [
    "exec",
    "resume",
    "fork",
    "login",
    "logout",
    "mcp",
    "mcp-server",
    "skills",
    "hooks",
    "init",
    "features",
    "sandbox"
  ].includes(value);
}

function readFlagValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("-")) {
    throw new NexusError({
      category: "config",
      message: `Flag '${flag}' requires a value.`,
      recoverable: true
    });
  }
  return value;
}

function parseSandboxMode(value: string): "read-only" | "workspace-write" | "danger-full-access" {
  if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") {
    return value;
  }
  throw new NexusError({
    category: "config",
    message: `Invalid sandbox mode '${value}'.`,
    recoverable: true
  });
}

function parseApprovalPolicy(value: string): "always" | "on-request" | "on-failure" | "never" {
  if (value === "always" || value === "on-request" || value === "on-failure" || value === "never") {
    return value;
  }
  throw new NexusError({
    category: "config",
    message: `Invalid approval policy '${value}'.`,
    recoverable: true
  });
}

function exitCodeForError(error: unknown): number {
  if (!(error instanceof NexusError)) {
    return 1;
  }
  switch (error.category) {
    case "approval":
      return 2;
    case "sandbox":
      return 3;
    case "model":
      return 4;
    case "tool":
    case "security":
    case "network":
      return 5;
    case "config":
      return 7;
    case "auth":
      return 8;
    default:
      return 1;
  }
}

function helpText(): string {
  return `Nexus CLI ${VERSION}

Usage:
  nexus [prompt]
  nexus exec [--json] [flags] "<prompt>"
  nexus resume [--last]
  nexus fork [session-id] [prompt]
  nexus login [provider] --api-key <key>
  nexus logout [provider|--all]

Commands:
  nexus                Start interactive terminal mode
  nexus "<prompt>"     Start interactive mode and run an initial prompt
  exec                 Run a non-interactive task
  resume               Resume the latest local session
  fork                 Create a child session from the latest or specified session
  mcp                  List, add, remove, trust, enable, or restrict local MCP servers
  skills               List available skills
  hooks                List configured lifecycle hooks
  init                 Create .nexus/config.toml and AGENTS.md starter files
  features             Print resolved feature flags as JSON
  sandbox              Show sandbox status; use "sandbox doctor" for availability
  login/logout         Manage provider auth in the configured auth file
  --json               Stream JSONL events to stdout
  --model, -m          Override active model
  --model-provider     Override active provider
  --profile, -p        Select config profile
  --cd, -C             Set runtime working directory
  --sandbox            Override sandbox mode
  --ask-for-approval   Override approval policy
  --config, -c         Load an explicit config file
  --provider           Provider for login/logout (deepseek or openai)
  --api-key            API key to persist for login
  --auth-file          Override provider auth file path
  --organization       OpenAI organization for login
  --project            OpenAI project for login
  --all                Logout all supported providers
  --no-alt-screen      Use inline interactive fallback instead of the full-screen TUI
  --verify <cmd|auto>  Run verification after exec and exit 6 on failure
  --rollback-on-verify-fail Restore latest checkpoint when exec verification fails
  --allow-mutations   Allow non-interactive workspace file mutations with explicit opt-in
  --output <path>      Write final answer artifact to a workspace path
  --patch <path>       Write redacted session patch artifact to a workspace path
  --report <path>      Write verification report artifact to a workspace path
  --events <path>      Write JSONL event log artifact to a workspace path
  --review-report <path> Write review report artifact to a workspace path
  --learning-candidates <path> Write learning candidates artifact to a workspace path
  /goal <text>         Set the SDLC objective and definition of done
  /plan [text]         Create an implementation plan
  /verify [command]    Run or record verification
  /review              Review the session diff and changed files
  /ship                Generate release gate summary and ship artifact
  /rollback [id]       Restore the latest checkpoint or a specific checkpoint id
  /compact             Generate learning candidates from session context
  /memories [action]   Show, accept, reject, edit, or delete memories
  /agent [task]        Run a read-only subagent task
  /mcp                 Show configured MCP servers
  /skills              Show available skills
  /hooks               Show configured lifecycle hooks
  /approvals           Show pending approval requests
  /approve [id]        Approve a pending tool request
  /deny [id]           Deny a pending tool request
  --help, -h           Show help
  --version, -V        Show version
`;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = exitCodeForError(error);
});
