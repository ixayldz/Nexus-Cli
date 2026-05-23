import { type ResolvedConfig } from "@nexus/config";
import { ContextCompiler } from "@nexus/context";
import {
  type EventBus,
  InMemoryEventBus,
  JsonlEventWriter,
  type Unsubscribe,
  createEvent
} from "@nexus/events";
import { HookRunner } from "@nexus/hooks";
import { McpRegistry } from "@nexus/mcp";
import { type DefaultModelRouter } from "@nexus/model-router";
import { ApprovalCoordinator, type SecurityRuntime } from "@nexus/security";
import { SandboxManager } from "@nexus/sandbox";
import { SdlcManager } from "@nexus/sdlc";
import {
  type ApprovalRequestId,
  type SessionId,
  type ThreadId,
  createId,
  nowIso,
  safeJsonStringify
} from "@nexus/shared";
import {
  type SessionManifest,
  type SessionStorage,
  createSessionStorage,
  listSessionManifests
} from "@nexus/storage";
import { SkillRegistry } from "@nexus/skills";
import { type ToolBus } from "@nexus/tool-bus";

export interface UserTurnInput {
  text: string;
  createdAt: string;
}

export interface TurnResult {
  finalMessage?: string;
  filesChanged: string[];
  commandsRun: string[];
  exitCodeHint?: number;
}

export interface NexusSession {
  id: SessionId;
  createdAt: string;
  cwd: string;
  mode: "interactive" | "non-interactive";
  config: ResolvedConfig;
  activeThreadId: ThreadId;
  eventLogPath: string;
  parentSessionId?: SessionId;
}

export interface RuntimeServices {
  models: DefaultModelRouter;
  tools: ToolBus;
  security: SecurityRuntime;
  context: ContextCompiler;
  approvals: ApprovalCoordinator;
  sandbox: SandboxManager;
  sdlc: SdlcManager;
  hooks: HookRunner;
  skills: SkillRegistry;
  mcp: McpRegistry;
}

export interface RuntimeContext {
  session: NexusSession;
  config: ResolvedConfig;
  eventBus: EventBus;
  storage: SessionStorage;
  services: RuntimeServices;
  nonInteractive: boolean;
}

export interface TurnRunnerInput {
  session: NexusSession;
  userInput: UserTurnInput;
  runtimeContext: RuntimeContext;
}

export interface TurnRunner {
  run(input: TurnRunnerInput): Promise<TurnResult>;
}

export interface StartSessionInput {
  cwd: string;
  mode: "interactive" | "non-interactive";
  parentSessionId?: SessionId;
}

export interface ResumeSessionInput {
  cwd: string;
  sessionId?: SessionId;
  last?: boolean;
  mode?: "interactive" | "non-interactive";
}

export interface ForkSessionInput {
  cwd: string;
  mode: "interactive" | "non-interactive";
}

export class NexusRuntime {
  private session: NexusSession | undefined;
  private storage: SessionStorage | undefined;
  private readonly config: ResolvedConfig;
  private readonly services: RuntimeServices;
  private readonly turnRunner: TurnRunner;
  private eventWriterUnsubscribe: Unsubscribe | undefined;
  public readonly eventBus: EventBus;

  public constructor(input: {
    config: ResolvedConfig;
    services: RuntimeServices;
    turnRunner: TurnRunner;
    eventBus?: EventBus;
  }) {
    this.config = input.config;
    this.services = input.services;
    this.turnRunner = input.turnRunner;
    this.eventBus = input.eventBus ?? new InMemoryEventBus();
  }

  public async startSession(input: StartSessionInput): Promise<NexusSession> {
    const sessionId = createId("nx") as unknown as SessionId;
    const threadId = createId("thread") as unknown as ThreadId;
    const storage = await createSessionStorage({ cwd: input.cwd, sessionId });
    this.attachEventWriter(storage.eventLogPath);

    const session: NexusSession = {
      id: sessionId,
      createdAt: nowIso(),
      cwd: storage.cwd,
      mode: input.mode,
      config: this.config,
      activeThreadId: threadId,
      eventLogPath: storage.eventLogPath,
      ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {})
    };

    this.session = session;
    this.storage = storage;

    await storage.writeManifest(createManifest(session, storage));
    await this.eventBus.publish(
      createEvent({
        sessionId,
        threadId,
        type: "session.started",
        data: {
          cwd: session.cwd,
          mode: session.mode,
          eventLogPath: session.eventLogPath,
          parentSessionId: input.parentSessionId ?? ""
        }
      })
    );

    return session;
  }

  public async resumeSession(input: ResumeSessionInput): Promise<NexusSession> {
    const manifests = await listSessionManifests({ cwd: input.cwd });
    const manifest = input.sessionId
      ? manifests.find((candidate) => candidate.sessionId === input.sessionId)
      : manifests[0];
    if (!manifest) {
      throw new Error(
        input.sessionId
          ? `Session '${input.sessionId}' was not found.`
          : "No previous session was found."
      );
    }

    const threadId = createId("thread") as unknown as ThreadId;
    const storage = await createSessionStorage({ cwd: input.cwd, sessionId: manifest.sessionId });
    this.attachEventWriter(storage.eventLogPath);
    const session: NexusSession = {
      id: manifest.sessionId,
      createdAt: manifest.startedAt,
      cwd: storage.cwd,
      mode: input.mode ?? manifest.mode,
      config: this.config,
      activeThreadId: threadId,
      eventLogPath: storage.eventLogPath,
      ...(manifest.parentSessionId ? { parentSessionId: manifest.parentSessionId } : {})
    };

    this.session = session;
    this.storage = storage;
    await storage.writeManifest(
      createManifest(session, storage, undefined, manifest.parentSessionId, "running")
    );
    await this.eventBus.publish(
      createEvent({
        sessionId: session.id,
        threadId,
        type: "session.started",
        data: {
          cwd: session.cwd,
          mode: session.mode,
          eventLogPath: session.eventLogPath,
          resumed: true
        }
      })
    );
    return session;
  }

  public async forkSession(sessionId: SessionId, input: ForkSessionInput): Promise<NexusSession> {
    return this.startSession({ cwd: input.cwd, mode: input.mode, parentSessionId: sessionId });
  }

  public async approve(
    requestId: ApprovalRequestId,
    scope: "once" | "session" = "once"
  ): Promise<void> {
    this.services.approvals.decide(
      requestId,
      scope === "session" ? "approved_for_session" : "approved"
    );
  }

  public async deny(requestId: ApprovalRequestId): Promise<void> {
    this.services.approvals.decide(requestId, "denied");
  }

  public async stop(): Promise<void> {
    if (!this.session || !this.storage) {
      return;
    }
    for (const approval of this.services.approvals.list(this.session.id)) {
      if (approval.status === "pending") {
        this.services.approvals.decide(approval.id, "denied");
      }
    }
    await this.storage.writeManifest(
      createManifest(this.session, this.storage, undefined, this.session.parentSessionId, "stopped")
    );
  }

  public async runTurn(input: UserTurnInput): Promise<TurnResult> {
    if (!this.session || !this.storage) {
      throw new Error("Session has not been started.");
    }

    return this.turnRunner.run({
      session: this.session,
      userInput: input,
      runtimeContext: {
        session: this.session,
        config: this.config,
        eventBus: this.eventBus,
        storage: this.storage,
        services: this.services,
        nonInteractive: this.session.mode === "non-interactive"
      }
    });
  }

  public getStorage(): SessionStorage {
    if (!this.storage) {
      throw new Error("Session has not been started.");
    }
    return this.storage;
  }

  public async complete(result: TurnResult): Promise<void> {
    if (!this.session || !this.storage) {
      throw new Error("Session has not been started.");
    }

    const previous = await this.storage.readManifest().catch(() => undefined);
    const manifest = mergeManifest(
      previous,
      createManifest(this.session, this.storage, result, this.session.parentSessionId, "completed")
    );
    await this.storage.writeManifest(manifest);
    if (result.finalMessage) {
      await this.storage.writeArtifact("finalAnswerPath", `${result.finalMessage}\n`);
    }
    await this.storage.writeArtifact(
      "metricsPath",
      `${safeJsonStringify({
        sessionId: this.session.id,
        status: manifest.status,
        startedAt: this.session.createdAt,
        completedAt: manifest.completedAt ?? nowIso(),
        filesChanged: result.filesChanged.length,
        commandsRun: result.commandsRun.length,
        exitCodeHint: result.exitCodeHint ?? 0,
        modelProvider: this.session.config.modelProvider,
        model: this.session.config.model
      })}\n`
    );

    await this.eventBus.publish(
      createEvent({
        sessionId: this.session.id,
        threadId: this.session.activeThreadId,
        type: "session.completed",
        data: {
          filesChanged: result.filesChanged,
          commandsRun: result.commandsRun,
          exitCodeHint: result.exitCodeHint ?? 0
        }
      })
    );
  }

  private attachEventWriter(eventLogPath: string): void {
    this.eventWriterUnsubscribe?.();
    const eventWriter = new JsonlEventWriter(eventLogPath);
    this.eventWriterUnsubscribe = this.eventBus.subscribe((event) => eventWriter.write(event));
  }
}

function createManifest(
  session: NexusSession,
  storage: SessionStorage,
  result?: TurnResult,
  parentSessionId?: SessionId,
  status: "running" | "completed" | "stopped" = result ? "completed" : "running"
): SessionManifest {
  const parent = parentSessionId ?? session.parentSessionId;
  return {
    sessionId: session.id,
    ...(parent ? { parentSessionId: parent } : {}),
    startedAt: session.createdAt,
    ...(result ? { completedAt: nowIso() } : {}),
    cwd: session.cwd,
    mode: session.mode,
    model: session.config.model,
    modelProvider: session.config.modelProvider,
    sandboxMode: session.config.sandboxMode,
    approvalPolicy: session.config.approvalPolicy,
    status,
    eventLogPath: storage.eventLogPath,
    filesChanged: result?.filesChanged ?? [],
    commandsRun: result?.commandsRun ?? [],
    artifacts: storage.artifacts,
    ...(result?.exitCodeHint === 6 ? { verificationStatus: "failed" as const } : {})
  };
}

function mergeManifest(
  previous: SessionManifest | undefined,
  next: SessionManifest
): SessionManifest {
  if (!previous) {
    return next;
  }
  const artifacts = previous.artifacts ?? next.artifacts;
  const merged: SessionManifest = {
    ...previous,
    ...next
  };
  if (artifacts) {
    merged.artifacts = artifacts;
  }
  const sdlcStages = next.sdlcStages ?? previous.sdlcStages;
  if (sdlcStages) {
    merged.sdlcStages = sdlcStages;
  }
  const verificationStatus = next.verificationStatus ?? previous.verificationStatus;
  if (verificationStatus) {
    merged.verificationStatus = verificationStatus;
  }
  const reviewStatus = next.reviewStatus ?? previous.reviewStatus;
  if (reviewStatus) {
    merged.reviewStatus = reviewStatus;
  }
  const learningCandidateCount = next.learningCandidateCount ?? previous.learningCandidateCount;
  if (learningCandidateCount !== undefined) {
    merged.learningCandidateCount = learningCandidateCount;
  }
  return merged;
}

export function createDefaultRuntimeServices(input: {
  models: DefaultModelRouter;
  tools: ToolBus;
  security: SecurityRuntime;
}): RuntimeServices {
  return {
    models: input.models,
    tools: input.tools,
    security: input.security,
    context: new ContextCompiler(),
    approvals: new ApprovalCoordinator(),
    sandbox: new SandboxManager(),
    sdlc: new SdlcManager(),
    hooks: new HookRunner(),
    skills: new SkillRegistry(),
    mcp: new McpRegistry()
  };
}
