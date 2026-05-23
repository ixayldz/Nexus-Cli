import { readFile } from "node:fs/promises";
import { type ResolvedConfig } from "@nexus/config";
import { ContextCompiler, type SessionReplaySummary } from "@nexus/context";
import {
  type EventBus,
  InMemoryEventBus,
  JsonlEventWriter,
  type NexusEvent,
  type Unsubscribe,
  createEvent,
  readJsonlEvents
} from "@nexus/events";
import { HookRunner } from "@nexus/hooks";
import { McpRegistry } from "@nexus/mcp";
import { type DefaultModelRouter } from "@nexus/model-router";
import { ApprovalCoordinator, type SecurityRuntime } from "@nexus/security";
import { SandboxManager } from "@nexus/sandbox";
import {
  type Plan,
  type ReviewResult,
  SdlcManager,
  type SdlcStage,
  type SdlcStageRun,
  type SdlcState,
  type ShipArtifact,
  type VerificationReport,
  createInitialSdlcState
} from "@nexus/sdlc";
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
    this.attachEventWriter(storage.eventLogPath);

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
    const replayEvents = await readJsonlEvents(storage.eventLogPath).catch(() => []);
    const replay = buildSessionReplaySummary(manifest, replayEvents);
    this.services.context = new ContextCompiler({ sessionReplay: replay });
    this.services.sdlc = await restoreSdlcManagerFromReplay(manifest, storage, replayEvents);
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
    this.attachEventWriter(storage.eventLogPath);
    await storage.writeManifest(
      mergeManifest(
        manifest,
        createManifest(session, storage, undefined, manifest.parentSessionId, "running", {
          replayedAt: nowIso(),
          replayedEventCount: replay.eventCount,
          transcriptMessageCount: replay.transcript.length,
          sdlcStageCount: replay.sdlcStages.length,
          learningCandidateCount: replay.learningCandidateCount
        })
      )
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
          resumed: true,
          replayedEventCount: replay.eventCount,
          transcriptMessageCount: replay.transcript.length,
          sdlcStageCount: replay.sdlcStages.length,
          learningCandidateCount: replay.learningCandidateCount
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
    if (!this.session || !this.storage) {
      return;
    }
    const eventWriter = new JsonlEventWriter(eventLogPath, {
      allowedRoot: this.storage.runDirectory,
      workspaceRoot: this.session.cwd
    });
    this.eventWriterUnsubscribe = this.eventBus.subscribe((event) => eventWriter.write(event));
  }
}

function createManifest(
  session: NexusSession,
  storage: SessionStorage,
  result?: TurnResult,
  parentSessionId?: SessionId,
  status: "running" | "completed" | "stopped" = result ? "completed" : "running",
  resumeReplay?: NonNullable<SessionManifest["resumeReplay"]>
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
    ...(resumeReplay ? { resumeReplay } : {}),
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
  const resumeReplay = next.resumeReplay ?? previous.resumeReplay;
  if (resumeReplay) {
    merged.resumeReplay = resumeReplay;
  }
  return merged;
}

function buildSessionReplaySummary(
  manifest: SessionManifest,
  events: NexusEvent[]
): SessionReplaySummary {
  const filesChanged = new Set(manifest.filesChanged ?? []);
  const commandsRun = new Set(manifest.commandsRun ?? []);
  const transcript: SessionReplaySummary["transcript"] = [];
  const sdlcStages: string[] = [];
  let learningCandidateCount = manifest.learningCandidateCount ?? 0;

  for (const event of events) {
    if (event.type === "user.input" || event.type === "assistant.message") {
      const text = readString(event.text);
      if (text) {
        transcript.push({
          role: event.type === "user.input" ? "user" : "assistant",
          text,
          timestamp: event.timestamp
        });
      }
    }
    for (const file of readStringArray(event.filesChanged)) {
      filesChanged.add(file);
    }
    for (const file of readStringArray(event.files)) {
      filesChanged.add(file);
    }
    const changedPath = readString(event.path);
    if (event.type === "file.changed" && changedPath) {
      filesChanged.add(changedPath);
    }
    for (const command of readStringArray(event.commandsRun)) {
      commandsRun.add(command);
    }
    const command = readString(event.command);
    if (command && (event.type === "shell.completed" || event.type === "verification.completed")) {
      commandsRun.add(command);
    }
    if (event.type.startsWith("sdlc.stage.")) {
      const stage = readString(event.stage);
      if (stage) {
        sdlcStages.push(`${stage}:${event.type.replace("sdlc.stage.", "")}`);
      }
    }
    if (event.type === "learning.candidate.created") {
      learningCandidateCount += 1;
    }
  }

  return {
    resumed: true,
    eventCount: events.length,
    transcript: transcript.slice(-40),
    filesChanged: [...filesChanged].sort(),
    commandsRun: [...commandsRun].sort(),
    sdlcStages: manifest.sdlcStages ?? sdlcStages,
    learningCandidateCount
  };
}

async function restoreSdlcManagerFromReplay(
  manifest: SessionManifest,
  storage: SessionStorage,
  events: NexusEvent[]
): Promise<SdlcManager> {
  const state = replaySdlcEvents(manifest, events);
  const plan = await readJsonArtifact<Plan>(storage.artifacts.planPath);
  const verification = await readJsonArtifact<VerificationReport>(
    storage.artifacts.verificationPath
  );
  const review = await readJsonArtifact<ReviewResult>(storage.artifacts.reviewPath);
  const ship = await readJsonArtifact<ShipArtifact>(storage.artifacts.shipPath);

  return new SdlcManager({
    ...state,
    ...(plan ? { plan } : {}),
    ...(verification ? { verification } : {}),
    ...(review ? { review } : {}),
    ...(ship ? { ship } : {})
  });
}

function replaySdlcEvents(manifest: SessionManifest, events: NexusEvent[]): SdlcState {
  let state: SdlcState = createInitialSdlcState();

  for (const event of events) {
    if (event.type === "sdlc.goal.updated") {
      const goal = readString(event.goal);
      if (goal) {
        state = {
          ...state,
          currentStage: "plan",
          goal: {
            text: goal,
            createdAt: event.timestamp
          }
        };
      }
      continue;
    }

    if (event.type === "sdlc.definition_of_done.updated") {
      const items = Array.isArray(event.items) ? event.items : [];
      state = {
        ...state,
        definitionOfDone: items as SdlcState["definitionOfDone"]
      };
      continue;
    }

    if (event.type === "plan.updated" && isRecord(event.plan)) {
      state = {
        ...state,
        currentStage: "plan",
        plan: event.plan as unknown as Plan
      };
      continue;
    }

    if (event.type === "sdlc.stage.started" && isSdlcStage(event.stage)) {
      const run: SdlcStageRun = {
        id: event.id,
        stage: event.stage,
        status: "running",
        startedAt: event.timestamp
      };
      state = {
        ...state,
        currentStage: event.stage,
        stageRuns: [...state.stageRuns, run]
      };
      continue;
    }

    if (event.type === "sdlc.stage.completed" && isSdlcStage(event.stage)) {
      state = {
        ...state,
        completedStages: markCompletedReplay(state.completedStages, event.stage),
        stageRuns: updateLatestStageRunReplay(state.stageRuns, event.stage, {
          status: "completed",
          completedAt: event.timestamp
        })
      };
      continue;
    }

    if (event.type === "sdlc.stage.blocked" && isSdlcStage(event.stage)) {
      const reason = readString(event.reason) ?? "Resumed blocked stage.";
      state = {
        ...state,
        blockedReason: reason,
        stageRuns: updateLatestStageRunReplay(state.stageRuns, event.stage, {
          status: "blocked",
          completedAt: event.timestamp,
          blockedReason: reason
        })
      };
      continue;
    }

    if (event.type === "verification.completed") {
      const status = normalizeVerificationStatus(event.status);
      state = {
        ...state,
        currentStage: "verify",
        verification: {
          status,
          command: readString(event.command) ?? "",
          summary: readString(event.summary) ?? "Restored from session event log.",
          required: true,
          startedAt: event.timestamp,
          completedAt: event.timestamp,
          evidenceEventIds: []
        }
      };
      continue;
    }

    if (event.type === "review.completed") {
      state = {
        ...state,
        currentStage: "review",
        review: {
          status: normalizeReviewStatus(event.status),
          findings: Array.isArray(event.findings)
            ? (event.findings as ReviewResult["findings"])
            : [],
          semanticFindings: Array.isArray(event.semanticFindings)
            ? (event.semanticFindings as ReviewResult["semanticFindings"])
            : [],
          coverageHints: Array.isArray(event.coverageHints)
            ? (event.coverageHints.filter((item) => typeof item === "string") as string[])
            : [],
          summary: readString(event.summary) ?? "Restored from session event log.",
          filesReviewed: manifest.filesChanged ?? [],
          createdAt: event.timestamp
        }
      };
      continue;
    }
  }

  return state;
}

async function readJsonArtifact<T>(path: string): Promise<T | undefined> {
  const content = await readFile(path, "utf8").catch(() => undefined);
  if (!content) {
    return undefined;
  }
  try {
    return JSON.parse(content) as T;
  } catch {
    return undefined;
  }
}

function updateLatestStageRunReplay(
  runs: SdlcStageRun[],
  stage: SdlcStage,
  patch: Pick<SdlcStageRun, "status"> & Partial<Pick<SdlcStageRun, "completedAt" | "blockedReason">>
): SdlcStageRun[] {
  let index = -1;
  for (let runIndex = runs.length - 1; runIndex >= 0; runIndex -= 1) {
    const run = runs[runIndex];
    if (run?.stage === stage && run.status === "running") {
      index = runIndex;
      break;
    }
  }
  if (index < 0) {
    const synthetic: SdlcStageRun = {
      id: createId("stage"),
      stage,
      status: patch.status,
      startedAt: patch.completedAt ?? nowIso(),
      ...(patch.completedAt ? { completedAt: patch.completedAt } : {}),
      ...(patch.blockedReason ? { blockedReason: patch.blockedReason } : {})
    };
    return [...runs, synthetic];
  }
  return runs.map((run, runIndex) => (runIndex === index ? { ...run, ...patch } : run));
}

function markCompletedReplay(completed: SdlcStage[], stage: SdlcStage): SdlcStage[] {
  return completed.includes(stage) ? completed : [...completed, stage];
}

function isSdlcStage(value: unknown): value is SdlcStage {
  return (
    value === "discover" ||
    value === "plan" ||
    value === "implement" ||
    value === "verify" ||
    value === "review" ||
    value === "ship" ||
    value === "learn"
  );
}

function normalizeVerificationStatus(value: unknown): VerificationReport["status"] {
  return value === "passed" || value === "failed" || value === "skipped" ? value : "skipped";
}

function normalizeReviewStatus(value: unknown): ReviewResult["status"] {
  return value === "passed" || value === "warnings" || value === "failed" ? value : "warnings";
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
