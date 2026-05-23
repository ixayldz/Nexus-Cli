import { type CompiledContext } from "@nexus/context";
import { type EventBus, createEvent } from "@nexus/events";
import { type EventId, type PlanId, type SessionId, createId, nowIso } from "@nexus/shared";

export type SdlcStage = "discover" | "plan" | "implement" | "verify" | "review" | "ship" | "learn";
export type StageStatus = "running" | "completed" | "blocked";

export interface Goal {
  text: string;
  createdAt: string;
}

export interface DefinitionOfDoneItem {
  id: string;
  text: string;
  status: "pending" | "passed" | "failed" | "skipped";
  evidenceEventIds: EventId[];
}

export interface SdlcStageRun {
  id: string;
  stage: SdlcStage;
  status: StageStatus;
  startedAt: string;
  completedAt?: string;
  blockedReason?: string;
}

export interface DiscoveryResult {
  repoRoot: string;
  packageManager: "pnpm" | "npm" | "yarn" | "unknown";
  topLevelFiles: string[];
  packageScripts: Record<string, string>;
  testCommands: string[];
  agentsMdFound: boolean;
  gitBranch: string;
  gitAvailable: boolean;
  repoMapFileCount: number;
  repoMapTruncated: boolean;
  promptInjectionFindingCount: number;
  compactSummary: string;
}

export interface PlanStep {
  id: string;
  text: string;
  status: "pending" | "done";
  files?: string[];
}

export interface PlanRisk {
  id: string;
  text: string;
  severity: "low" | "medium" | "high";
}

export interface VerificationCommand {
  command: string;
  required: boolean;
  reason?: string;
}

export interface Plan {
  id: PlanId;
  goal: string;
  summary: string;
  steps: PlanStep[];
  risks: PlanRisk[];
  verification: VerificationCommand[];
  approvalRequirements: string[];
  files: string[];
  definitionOfDone: DefinitionOfDoneItem[];
  source: "deterministic" | "model" | "hybrid";
  createdAt: string;
}

export type StructuredPlan = Plan;

export interface ModelPlanSuggestion {
  summary?: string;
  steps?: string[];
  risks?: Array<{ text: string; severity?: "low" | "medium" | "high" }>;
  verification?: Array<{ command: string; required?: boolean; reason?: string }> | string[];
  approvalRequirements?: string[];
  files?: string[];
}

export interface VerificationReport {
  status: "passed" | "failed" | "skipped";
  command: string;
  summary: string;
  required: boolean;
  startedAt: string;
  completedAt: string;
  evidenceEventIds: EventId[];
}

export interface ReviewFinding {
  id: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  title: string;
  description: string;
  file?: string;
  line?: number;
  recommendation?: string;
  category?: "correctness" | "security" | "testing" | "maintainability" | "process";
}

export interface ReviewResult {
  status: "passed" | "warnings" | "failed";
  findings: ReviewFinding[];
  summary: string;
  filesReviewed: string[];
  createdAt: string;
}

export interface ShipArtifact {
  status: "ready" | "blocked";
  summary: string;
  filesChanged: string[];
  commandsRun: string[];
  verificationStatus: "passed" | "failed" | "skipped" | "missing";
  reviewStatus: "passed" | "warnings" | "failed" | "missing";
  risks: string[];
  rollbackNote: string;
  createdAt: string;
}

export interface SdlcState {
  currentStage: SdlcStage;
  goal?: Goal;
  discovery?: DiscoveryResult;
  definitionOfDone: DefinitionOfDoneItem[];
  completedStages: SdlcStage[];
  stageRuns: SdlcStageRun[];
  blockedReason?: string;
  plan?: Plan;
  verification?: VerificationReport;
  review?: ReviewResult;
  ship?: ShipArtifact;
}

export function createInitialSdlcState(): SdlcState {
  return {
    currentStage: "discover",
    definitionOfDone: [],
    completedStages: [],
    stageRuns: []
  };
}

export class SdlcManager {
  public constructor(private state: SdlcState = createInitialSdlcState()) {}

  public getState(): SdlcState {
    return structuredClone(this.state);
  }

  public async discover(input: {
    sessionId: SessionId;
    eventBus: EventBus;
    context: CompiledContext;
  }): Promise<DiscoveryResult> {
    await this.startStage({
      sessionId: input.sessionId,
      eventBus: input.eventBus,
      stage: "discover"
    });
    const discovery: DiscoveryResult = {
      repoRoot: input.context.repository.repoRoot,
      packageManager: input.context.repository.packageManager,
      topLevelFiles: input.context.repository.topLevelFiles,
      packageScripts: input.context.repository.packageScripts,
      testCommands: input.context.repository.testCommands,
      agentsMdFound: Boolean(input.context.repository.agentsMd),
      gitBranch: input.context.repository.git.branch,
      gitAvailable: input.context.repository.git.available,
      repoMapFileCount: input.context.repository.repoMap.files.length,
      repoMapTruncated: input.context.repository.repoMap.truncated,
      promptInjectionFindingCount: input.context.security.promptInjectionFindings.length,
      compactSummary: input.context.compactSummary
    };
    this.state = {
      ...clearBlocked(this.state),
      currentStage: "discover",
      discovery
    };
    await this.completeStage({
      sessionId: input.sessionId,
      eventBus: input.eventBus,
      stage: "discover"
    });
    return discovery;
  }

  public async setGoal(input: {
    sessionId: SessionId;
    eventBus: EventBus;
    goal: string;
    createdAt: string;
  }): Promise<SdlcState> {
    this.state = {
      ...clearBlocked(this.state),
      currentStage: "plan",
      goal: {
        text: input.goal,
        createdAt: input.createdAt
      },
      definitionOfDone: createDefinitionOfDone(input.goal),
      completedStages: markCompleted(this.state.completedStages, "discover")
    };

    await input.eventBus.publish(
      createEvent({
        sessionId: input.sessionId,
        type: "sdlc.goal.updated",
        data: {
          goal: input.goal
        }
      })
    );
    await input.eventBus.publish(
      createEvent({
        sessionId: input.sessionId,
        type: "sdlc.definition_of_done.updated",
        data: {
          items: this.state.definitionOfDone
        }
      })
    );

    return this.getState();
  }

  public async createPlan(input: {
    sessionId: SessionId;
    eventBus: EventBus;
    context: CompiledContext;
    prompt?: string;
    modelPlan?: ModelPlanSuggestion;
  }): Promise<Plan> {
    if (!this.state.discovery) {
      await this.discover({
        sessionId: input.sessionId,
        eventBus: input.eventBus,
        context: input.context
      });
    }
    await this.startStage({ sessionId: input.sessionId, eventBus: input.eventBus, stage: "plan" });
    const goal =
      input.prompt?.trim() || this.state.goal?.text || "Complete the requested coding task";
    const verification = mergeVerification(
      detectVerification(input.context),
      input.modelPlan?.verification
    );
    const plan: Plan = {
      id: createId("plan") as unknown as PlanId,
      goal,
      summary: input.modelPlan?.summary ?? `Plan for: ${goal}`,
      steps: createPlanSteps(input.context, input.modelPlan),
      risks: createRisks(input.context, input.modelPlan),
      verification,
      approvalRequirements:
        input.modelPlan?.approvalRequirements?.filter((item) => item.trim().length > 0) ??
        defaultApprovalRequirements(verification),
      files:
        input.modelPlan?.files?.filter((item) => item.trim().length > 0) ??
        input.context.mentions.map((item) => item.path),
      definitionOfDone:
        this.state.definitionOfDone.length > 0
          ? this.state.definitionOfDone
          : createDefinitionOfDone(goal),
      source: input.modelPlan ? "hybrid" : "deterministic",
      createdAt: nowIso()
    };

    this.state = {
      ...clearBlocked(this.state),
      currentStage: "plan",
      plan,
      definitionOfDone: plan.definitionOfDone
    };

    await input.eventBus.publish(
      createEvent({
        sessionId: input.sessionId,
        type: "plan.updated",
        data: {
          plan
        }
      })
    );
    await this.completeStage({
      sessionId: input.sessionId,
      eventBus: input.eventBus,
      stage: "plan"
    });
    return plan;
  }

  public async markImplement(input: {
    sessionId: SessionId;
    eventBus: EventBus;
    filesChanged: string[];
  }): Promise<void> {
    if (input.filesChanged.length === 0) {
      return;
    }
    await this.startStage({
      sessionId: input.sessionId,
      eventBus: input.eventBus,
      stage: "implement"
    });
    this.state = {
      ...clearBlocked(this.state),
      currentStage: "implement",
      definitionOfDone: this.state.definitionOfDone.map((item) =>
        item.text.toLowerCase().includes("goal is addressed") ? { ...item, status: "passed" } : item
      )
    };
    await this.completeStage({
      sessionId: input.sessionId,
      eventBus: input.eventBus,
      stage: "implement"
    });
  }

  public async verify(input: {
    sessionId: SessionId;
    eventBus: EventBus;
    command?: string;
    status?: "passed" | "failed" | "skipped";
    summary?: string;
    required?: boolean;
    evidenceEventIds?: EventId[];
  }): Promise<VerificationReport> {
    await this.startStage({
      sessionId: input.sessionId,
      eventBus: input.eventBus,
      stage: "verify"
    });
    const status = input.status ?? "skipped";
    const report: VerificationReport = {
      status,
      command: input.command ?? "",
      summary: input.summary ?? "Verification was not run.",
      required: input.required ?? true,
      startedAt: nowIso(),
      completedAt: nowIso(),
      evidenceEventIds: input.evidenceEventIds ?? []
    };
    this.state = {
      ...clearBlocked(this.state),
      currentStage: "verify",
      verification: report,
      definitionOfDone: this.state.definitionOfDone.map((item) =>
        item.text.toLowerCase().includes("verification") ||
        item.text.toLowerCase().includes("tests")
          ? { ...item, status, evidenceEventIds: report.evidenceEventIds }
          : item
      )
    };
    await input.eventBus.publish(
      createEvent({
        sessionId: input.sessionId,
        type: "verification.completed",
        data: {
          status,
          command: report.command,
          summary: report.summary
        }
      })
    );
    if (status === "failed") {
      await this.blockStage({
        sessionId: input.sessionId,
        eventBus: input.eventBus,
        stage: "verify",
        reason: report.summary
      });
    } else {
      await this.completeStage({
        sessionId: input.sessionId,
        eventBus: input.eventBus,
        stage: "verify"
      });
    }
    return report;
  }

  public async review(input: {
    sessionId: SessionId;
    eventBus: EventBus;
    filesChanged: string[];
    diff?: string;
    modelFindings?: ReviewFinding[];
  }): Promise<ReviewResult> {
    await this.startStage({
      sessionId: input.sessionId,
      eventBus: input.eventBus,
      stage: "review"
    });
    const findings = sortFindings([
      ...reviewDiff(input.filesChanged, input.diff),
      ...(input.modelFindings ?? [])
    ]);

    const result: ReviewResult = {
      status: findings.some(
        (finding) => finding.severity === "high" || finding.severity === "critical"
      )
        ? "failed"
        : findings.length > 0
          ? "warnings"
          : "passed",
      findings,
      summary:
        findings.length === 0
          ? `Reviewed ${input.filesChanged.length} changed file(s); no findings.`
          : `Review produced ${findings.length} finding(s).`,
      filesReviewed: [...new Set(input.filesChanged)].sort(),
      createdAt: nowIso()
    };

    this.state = {
      ...clearBlocked(this.state),
      currentStage: "review",
      review: result,
      definitionOfDone: this.state.definitionOfDone.map((item) =>
        item.text.toLowerCase().includes("diff review")
          ? { ...item, status: result.status === "failed" ? "failed" : "passed" }
          : item
      )
    };

    await input.eventBus.publish(
      createEvent({
        sessionId: input.sessionId,
        type: "review.completed",
        data: {
          status: result.status,
          findings: result.findings,
          summary: result.summary
        }
      })
    );
    if (result.status === "failed") {
      await this.blockStage({
        sessionId: input.sessionId,
        eventBus: input.eventBus,
        stage: "review",
        reason: result.summary
      });
    } else {
      await this.completeStage({
        sessionId: input.sessionId,
        eventBus: input.eventBus,
        stage: "review"
      });
    }
    return result;
  }

  public async learn(input: {
    sessionId: SessionId;
    eventBus: EventBus;
    candidateCount: number;
  }): Promise<void> {
    await this.startStage({ sessionId: input.sessionId, eventBus: input.eventBus, stage: "learn" });
    this.state = {
      ...clearBlocked(this.state),
      currentStage: "learn"
    };
    if (input.candidateCount === 0) {
      await input.eventBus.publish(
        createEvent({
          sessionId: input.sessionId,
          type: "memory.written",
          data: {
            path: "",
            entries: []
          }
        })
      );
    }
    await this.completeStage({
      sessionId: input.sessionId,
      eventBus: input.eventBus,
      stage: "learn"
    });
  }

  public async ship(input: {
    sessionId: SessionId;
    eventBus: EventBus;
    filesChanged: string[];
    commandsRun: string[];
    rollbackNote?: string;
  }): Promise<ShipArtifact> {
    await this.startStage({ sessionId: input.sessionId, eventBus: input.eventBus, stage: "ship" });
    const verificationStatus = this.state.verification?.status ?? "missing";
    const reviewStatus = this.state.review?.status ?? "missing";
    const risks = [
      ...(verificationStatus === "missing" ? ["Verification has not been recorded."] : []),
      ...(verificationStatus === "failed" ? ["Verification failed."] : []),
      ...(reviewStatus === "missing" ? ["Review has not been recorded."] : []),
      ...(reviewStatus === "failed" ? ["Review failed."] : [])
    ];
    const artifact: ShipArtifact = {
      status: risks.length === 0 ? "ready" : "blocked",
      summary:
        risks.length === 0
          ? `Ready to ship ${input.filesChanged.length} changed file(s).`
          : `Blocked by ${risks.length} release gate(s).`,
      filesChanged: [...new Set(input.filesChanged)].sort(),
      commandsRun: [...new Set(input.commandsRun)].sort(),
      verificationStatus,
      reviewStatus,
      risks,
      rollbackNote:
        input.rollbackNote ??
        "Use recorded checkpoints or git diff to revert this session's changes.",
      createdAt: nowIso()
    };
    this.state = {
      ...clearBlocked(this.state),
      currentStage: "ship",
      ship: artifact
    };
    await input.eventBus.publish(
      createEvent({
        sessionId: input.sessionId,
        type: "ship.completed",
        data: {
          status: artifact.status,
          summary: artifact.summary,
          filesChanged: artifact.filesChanged,
          verificationStatus: artifact.verificationStatus,
          reviewStatus: artifact.reviewStatus
        }
      })
    );
    if (artifact.status === "blocked") {
      await this.blockStage({
        sessionId: input.sessionId,
        eventBus: input.eventBus,
        stage: "ship",
        reason: artifact.summary
      });
    } else {
      await this.completeStage({
        sessionId: input.sessionId,
        eventBus: input.eventBus,
        stage: "ship"
      });
    }
    return artifact;
  }

  public async startStage(input: {
    sessionId: SessionId;
    eventBus: EventBus;
    stage: SdlcStage;
  }): Promise<void> {
    const run: SdlcStageRun = {
      id: createId("stage") as unknown as string,
      stage: input.stage,
      status: "running",
      startedAt: nowIso()
    };
    this.state = {
      ...this.state,
      currentStage: input.stage,
      stageRuns: [...this.state.stageRuns, run]
    };
    await input.eventBus.publish(
      createEvent({
        sessionId: input.sessionId,
        type: "sdlc.stage.started",
        data: { stage: input.stage }
      })
    );
  }

  public async completeStage(input: {
    sessionId: SessionId;
    eventBus: EventBus;
    stage: SdlcStage;
  }): Promise<void> {
    this.state = {
      ...clearBlocked(this.state),
      completedStages: markCompleted(this.state.completedStages, input.stage),
      stageRuns: updateLatestStageRun(this.state.stageRuns, input.stage, {
        status: "completed",
        completedAt: nowIso()
      })
    };
    await input.eventBus.publish(
      createEvent({
        sessionId: input.sessionId,
        type: "sdlc.stage.completed",
        data: { stage: input.stage }
      })
    );
  }

  private async blockStage(input: {
    sessionId: SessionId;
    eventBus: EventBus;
    stage: SdlcStage;
    reason: string;
  }): Promise<void> {
    this.state = {
      ...this.state,
      blockedReason: input.reason,
      stageRuns: updateLatestStageRun(this.state.stageRuns, input.stage, {
        status: "blocked",
        completedAt: nowIso(),
        blockedReason: input.reason
      })
    };
    await input.eventBus.publish(
      createEvent({
        sessionId: input.sessionId,
        type: "sdlc.stage.blocked",
        severity: "warning",
        data: { stage: input.stage, reason: input.reason }
      })
    );
  }
}

function createDefinitionOfDone(goal: string): DefinitionOfDoneItem[] {
  return [
    {
      id: "dod_1",
      text: `Goal is addressed: ${goal}`,
      status: "pending",
      evidenceEventIds: []
    },
    {
      id: "dod_2",
      text: "Relevant verification or explicit skip is recorded.",
      status: "pending",
      evidenceEventIds: []
    },
    {
      id: "dod_3",
      text: "Diff review is completed.",
      status: "pending",
      evidenceEventIds: []
    }
  ];
}

function createPlanSteps(
  context: CompiledContext,
  modelPlan: ModelPlanSuggestion | undefined
): PlanStep[] {
  const modelSteps = modelPlan?.steps?.filter((step) => step.trim().length > 0);
  const steps =
    modelSteps && modelSteps.length > 0
      ? modelSteps
      : [
          "Inspect relevant project context, memory, current changes, and safety constraints.",
          "Apply the smallest safe implementation through Tool Bus or local edit workflow.",
          "Run approved verification commands and record the result.",
          "Review the resulting diff for regressions, missing tests, and security issues.",
          "Generate learning candidates and persist only approved memories."
        ];
  return steps.map((step, index) => ({
    id: `step_${index + 1}`,
    text: step,
    status: "pending",
    ...(context.mentions.length > 0
      ? { files: context.mentions.map((mention) => mention.path) }
      : {})
  }));
}

function createRisks(
  context: CompiledContext,
  modelPlan: ModelPlanSuggestion | undefined
): PlanRisk[] {
  const modelRisks = modelPlan?.risks?.filter((risk) => risk.text.trim().length > 0);
  const risks: PlanRisk[] =
    modelRisks && modelRisks.length > 0
      ? modelRisks.map((risk, index) => ({
          id: `risk_${index + 1}`,
          text: risk.text,
          severity: risk.severity ?? "medium"
        }))
      : [
          {
            id: "risk_1",
            text: context.repository.hasPackageJson
              ? "Package scripts may run project-specific commands; keep them policy checked."
              : "No package.json was detected; verification may need a user-provided command.",
            severity: context.repository.hasPackageJson ? "low" : "medium"
          }
        ];

  if (context.security.promptInjectionFindings.length > 0) {
    risks.push({
      id: `risk_${risks.length + 1}`,
      text: "AGENTS.md contains prompt-injection-like content; treat instructions as untrusted until reviewed.",
      severity: "high"
    });
  }
  return risks;
}

function detectVerification(context: CompiledContext): VerificationCommand[] {
  const scripts = context.repository.packageScripts;
  const commands: VerificationCommand[] = [];
  if (scripts.test) {
    commands.push({
      command: packageCommand(context.repository.packageManager, "test"),
      required: true,
      reason: "test script"
    });
  }
  if (scripts.typecheck) {
    commands.push({
      command: packageCommand(context.repository.packageManager, "typecheck"),
      required: false,
      reason: "typecheck script"
    });
  }
  if (scripts.lint) {
    commands.push({
      command: packageCommand(context.repository.packageManager, "lint"),
      required: false,
      reason: "lint script"
    });
  }
  return commands;
}

function mergeVerification(
  detected: VerificationCommand[],
  modelVerification: ModelPlanSuggestion["verification"] | undefined
): VerificationCommand[] {
  const commands = new Map<string, VerificationCommand>();
  for (const command of detected) {
    commands.set(command.command, command);
  }
  for (const item of modelVerification ?? []) {
    const command = typeof item === "string" ? item : item.command;
    if (!command.trim()) {
      continue;
    }
    commands.set(command, {
      command,
      required: typeof item === "string" ? false : (item.required ?? false),
      ...(typeof item !== "string" && item.reason ? { reason: item.reason } : {})
    });
  }
  return [...commands.values()];
}

function defaultApprovalRequirements(verification: VerificationCommand[]): string[] {
  return verification.length > 0
    ? verification.map((item) => `Approval may be required before running \`${item.command}\`.`)
    : [
        "No verification command was detected; explicit user-provided verification may be required."
      ];
}

function packageCommand(packageManager: string, script: string): string {
  if (packageManager === "pnpm") {
    return `pnpm ${script}`;
  }
  if (packageManager === "yarn") {
    return `yarn ${script}`;
  }
  return `npm run ${script}`;
}

function reviewDiff(filesChanged: string[], diff: string | undefined): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const uniqueFiles = [...new Set(filesChanged)];
  if (uniqueFiles.length === 0 && !diff?.trim()) {
    findings.push({
      id: "finding_1",
      severity: "info",
      title: "No diff to review",
      description: "The current session has not recorded changed files or a diff.",
      category: "process"
    });
  }
  if (diff && diff.length > 5000) {
    findings.push({
      id: `finding_${findings.length + 1}`,
      severity: "medium",
      title: "Large diff",
      description: "The diff is large enough to deserve focused manual review.",
      category: "maintainability"
    });
  }
  if (
    diff &&
    /\+.*(sk-[A-Za-z0-9_-]{8,}|api[_-]?key|Bearer\s+[A-Za-z0-9._~+/=-]{12,})/i.test(diff)
  ) {
    findings.push({
      id: `finding_${findings.length + 1}`,
      severity: "critical",
      title: "Potential secret introduced",
      description: "The diff appears to add a credential-like value or API key reference.",
      recommendation:
        "Remove the secret and load credentials from configured environment variables.",
      category: "security"
    });
  }
  const sourceTouched = uniqueFiles.some(
    (file) => /\.(ts|tsx|js|jsx)$/.test(file) && !/\.test\./.test(file)
  );
  const testsTouched = uniqueFiles.some((file) => /\.test\.(ts|tsx|js|jsx)$/.test(file));
  if (sourceTouched && !testsTouched) {
    findings.push({
      id: `finding_${findings.length + 1}`,
      severity: "low",
      title: "No test file changed",
      description: "Source files changed without a matching test update in the recorded file set.",
      recommendation: "Confirm existing tests cover the behavior or add focused coverage.",
      category: "testing"
    });
  }
  return findings;
}

function sortFindings(findings: ReviewFinding[]): ReviewFinding[] {
  return findings
    .map((finding, index) => ({ ...finding, id: finding.id || `finding_${index + 1}` }))
    .sort((left, right) => severityRank(right.severity) - severityRank(left.severity));
}

function severityRank(severity: ReviewFinding["severity"]): number {
  switch (severity) {
    case "critical":
      return 5;
    case "high":
      return 4;
    case "medium":
      return 3;
    case "low":
      return 2;
    case "info":
      return 1;
  }
}

function markCompleted(completed: SdlcStage[], stage: SdlcStage): SdlcStage[] {
  return completed.includes(stage) ? completed : [...completed, stage];
}

function updateLatestStageRun(
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
    return runs;
  }
  return runs.map((run, runIndex) => (runIndex === index ? { ...run, ...patch } : run));
}

function clearBlocked(state: SdlcState): SdlcState {
  const next = { ...state };
  delete next.blockedReason;
  return next;
}
