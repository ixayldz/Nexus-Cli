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
  file?: string | undefined;
  line?: number | undefined;
  recommendation?: string | undefined;
  category?: "correctness" | "security" | "testing" | "maintainability" | "process" | undefined;
}

export interface ReviewResult {
  status: "passed" | "warnings" | "failed";
  findings: ReviewFinding[];
  semanticFindings: ReviewFinding[];
  coverageHints: string[];
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
  prTitle: string;
  prDescription: string;
  changelog: string;
  releaseNotes: string;
  riskSummary: string;
  verificationSummary: string;
  rollbackPlan: string;
  changedFilesSummary: string;
  reviewerChecklist: string[];
  grounding: {
    goal: string;
    filesChanged: string[];
    commandsRun: string[];
    verificationStatus: "passed" | "failed" | "skipped" | "missing";
    reviewStatus: "passed" | "warnings" | "failed" | "missing";
    reviewFindingCount: number;
  };
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
    context?: CompiledContext;
  }): Promise<ReviewResult> {
    await this.startStage({
      sessionId: input.sessionId,
      eventBus: input.eventBus,
      stage: "review"
    });
    const findings = sortFindings(
      dedupeFindings([
        ...reviewDiff(input.filesChanged, input.diff),
        ...reviewContext(input.filesChanged, input.context),
        ...(input.modelFindings ?? [])
      ])
    );
    const semanticFindings = findings.filter((finding) =>
      ["correctness", "security", "testing"].includes(finding.category ?? "")
    );
    const coverageHints = buildCoverageHints(input.filesChanged, input.context);

    const result: ReviewResult = {
      status: findings.some(
        (finding) => finding.severity === "high" || finding.severity === "critical"
      )
        ? "failed"
        : findings.length > 0
          ? "warnings"
          : "passed",
      findings,
      semanticFindings,
      coverageHints,
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
          semanticFindings: result.semanticFindings,
          coverageHints: result.coverageHints,
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
    const filesChanged = [...new Set(input.filesChanged)].sort();
    const commandsRun = [...new Set(input.commandsRun)].sort();
    const reviewFindings = this.state.review?.findings ?? [];
    const risks = [
      ...(verificationStatus === "missing" ? ["Verification has not been recorded."] : []),
      ...(verificationStatus === "failed" ? ["Verification failed."] : []),
      ...(reviewStatus === "missing" ? ["Review has not been recorded."] : []),
      ...(reviewStatus === "failed" ? ["Review failed."] : []),
      ...reviewFindings
        .filter((finding) => finding.severity === "high" || finding.severity === "critical")
        .map((finding) => `${finding.severity.toUpperCase()}: ${finding.title}`)
    ];
    const goal = this.state.goal?.text ?? this.state.plan?.goal ?? "Nexus session changes";
    const rollbackPlan =
      input.rollbackNote ??
      "Use recorded checkpoints or git diff to revert this session's changes.";
    const changedFilesSummary = summarizeChangedFiles(filesChanged);
    const verificationSummary = summarizeVerification(this.state.verification, commandsRun);
    const riskSummary = summarizeShipRisks(risks, reviewFindings);
    const reviewerChecklist = buildReviewerChecklist(filesChanged, reviewFindings);
    const artifact: ShipArtifact = {
      status: risks.length === 0 ? "ready" : "blocked",
      summary:
        risks.length === 0
          ? `Ready to ship ${filesChanged.length} changed file(s).`
          : `Blocked by ${risks.length} release gate(s).`,
      filesChanged,
      commandsRun,
      verificationStatus,
      reviewStatus,
      risks,
      rollbackNote: rollbackPlan,
      prTitle: createPrTitle(goal, filesChanged),
      prDescription: buildPrDescription({
        goal,
        filesChanged,
        changedFilesSummary,
        verificationSummary,
        reviewStatus,
        reviewFindings,
        riskSummary,
        rollbackPlan,
        reviewerChecklist
      }),
      changelog: buildChangelog(filesChanged, goal),
      releaseNotes: buildReleaseNotes(goal, changedFilesSummary, riskSummary),
      riskSummary,
      verificationSummary,
      rollbackPlan,
      changedFilesSummary,
      reviewerChecklist,
      grounding: {
        goal,
        filesChanged,
        commandsRun,
        verificationStatus,
        reviewStatus,
        reviewFindingCount: reviewFindings.length
      },
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

function createPrTitle(goal: string, filesChanged: string[]): string {
  if (goal.trim()) {
    return goal.trim().slice(0, 80);
  }
  const category = dominantFileCategory(filesChanged);
  return `Update ${category} changes`;
}

function buildPrDescription(input: {
  goal: string;
  filesChanged: string[];
  changedFilesSummary: string;
  verificationSummary: string;
  reviewStatus: ShipArtifact["reviewStatus"];
  reviewFindings: ReviewFinding[];
  riskSummary: string;
  rollbackPlan: string;
  reviewerChecklist: string[];
}): string {
  const findings =
    input.reviewFindings.length > 0
      ? input.reviewFindings
          .map(
            (finding) =>
              `- ${finding.severity}: ${finding.title}${finding.file ? ` (${finding.file})` : ""}`
          )
          .join("\n")
      : `- Review status: ${input.reviewStatus}`;
  return [
    "## Summary",
    `- ${input.goal}`,
    "",
    "## Changes",
    input.changedFilesSummary,
    "",
    "## Verification",
    input.verificationSummary,
    "",
    "## Review Findings",
    findings,
    "",
    "## Risks",
    input.riskSummary,
    "",
    "## Rollback Plan",
    input.rollbackPlan,
    "",
    "## Reviewer Checklist",
    ...input.reviewerChecklist.map((item) => `- [ ] ${item}`)
  ].join("\n");
}

function buildChangelog(filesChanged: string[], goal: string): string {
  const categories = categorizeFiles(filesChanged);
  const lines = ["### Changed"];
  lines.push(`- ${goal}`);
  if (categories.tests > 0) {
    lines.push(`- Updated or reviewed ${categories.tests} test-related file(s).`);
  }
  if (categories.docs > 0) {
    lines.push(`- Updated ${categories.docs} documentation file(s).`);
  }
  if (categories.dependencies > 0) {
    lines.push(`- Updated ${categories.dependencies} dependency/package file(s).`);
  }
  return lines.join("\n");
}

function buildReleaseNotes(goal: string, changedFilesSummary: string, riskSummary: string): string {
  return [
    "### Summary",
    `- ${goal}`,
    "",
    "### Changed Files",
    changedFilesSummary,
    "",
    "### Risks",
    riskSummary
  ].join("\n");
}

function summarizeChangedFiles(filesChanged: string[]): string {
  if (filesChanged.length === 0) {
    return "- No recorded file changes.";
  }
  const categories = categorizeFiles(filesChanged);
  return [
    `- Files changed: ${filesChanged.length}`,
    `- Source: ${categories.source}`,
    `- Tests: ${categories.tests}`,
    `- Docs: ${categories.docs}`,
    `- Config/CI: ${categories.config}`,
    `- Dependencies: ${categories.dependencies}`,
    ...filesChanged.slice(0, 20).map((file) => `- ${file}`)
  ].join("\n");
}

function summarizeVerification(
  verification: VerificationReport | undefined,
  commandsRun: string[]
): string {
  if (!verification) {
    return "- Verification has not been recorded.";
  }
  return [
    `- Status: ${verification.status}`,
    verification.command ? `- Command: ${verification.command}` : "- Command: not recorded",
    `- Summary: ${verification.summary}`,
    ...(commandsRun.length > 0 ? [`- Commands run: ${commandsRun.join(", ")}`] : [])
  ].join("\n");
}

function summarizeShipRisks(risks: string[], findings: ReviewFinding[]): string {
  if (risks.length === 0 && findings.length === 0) {
    return "- No blocking risks were recorded by Nexus gates.";
  }
  return [
    ...risks.map((risk) => `- ${risk}`),
    ...findings
      .filter((finding) => finding.severity !== "high" && finding.severity !== "critical")
      .slice(0, 10)
      .map((finding) => `- ${finding.severity}: ${finding.title}`)
  ].join("\n");
}

function buildReviewerChecklist(filesChanged: string[], findings: ReviewFinding[]): string[] {
  const categories = categorizeFiles(filesChanged);
  const checklist = ["Confirm the implementation matches the stated goal."];
  if (categories.source > 0) {
    checklist.push("Review source changes for correctness and API compatibility.");
  }
  if (categories.tests > 0) {
    checklist.push("Confirm tests cover the changed behavior and are not focused/skipped.");
  } else if (categories.source > 0) {
    checklist.push("Confirm existing tests cover the source changes or request focused coverage.");
  }
  if (categories.dependencies > 0) {
    checklist.push("Review package and lockfile changes together.");
  }
  if (categories.config > 0) {
    checklist.push("Review configuration/CI changes for release impact.");
  }
  if (findings.some((finding) => finding.category === "security")) {
    checklist.push(
      "Review security findings and confirm no secret or unsafe execution path ships."
    );
  }
  return [...new Set(checklist)];
}

function dominantFileCategory(filesChanged: string[]): string {
  const categories = categorizeFiles(filesChanged);
  const entries = Object.entries(categories).sort((left, right) => right[1] - left[1]);
  return entries[0]?.[0] ?? "session";
}

function categorizeFiles(filesChanged: string[]): {
  source: number;
  tests: number;
  docs: number;
  config: number;
  dependencies: number;
  other: number;
} {
  const result = { source: 0, tests: 0, docs: 0, config: 0, dependencies: 0, other: 0 };
  for (const file of filesChanged) {
    if (isLockfile(file) || isPackageManifest(file)) {
      result.dependencies += 1;
    } else if (isTestFile(file)) {
      result.tests += 1;
    } else if (/\.(?:md|mdx|rst)$/i.test(file) || file.startsWith("docs/")) {
      result.docs += 1;
    } else if (
      /(?:^|[/\\])(?:\.github|\.nexus|config|configs)[/\\]/i.test(file) ||
      /\.(?:json|toml|ya?ml)$/i.test(file)
    ) {
      result.config += 1;
    } else if (isSourceFile(file)) {
      result.source += 1;
    } else {
      result.other += 1;
    }
  }
  return result;
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

interface DiffLine {
  line?: number | undefined;
  text: string;
}

interface DiffFileSummary {
  path: string;
  oldPath?: string;
  addedLines: DiffLine[];
  removedLines: DiffLine[];
}

function reviewDiff(filesChanged: string[], diff: string | undefined): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const uniqueFiles = [...new Set(filesChanged)];
  const diffFiles = parseDiffFiles(diff);
  const reviewedFiles = [...new Set([...uniqueFiles, ...diffFiles.map((file) => file.path)])];
  if (uniqueFiles.length === 0 && !diff?.trim()) {
    addFinding(findings, {
      severity: "info",
      title: "No diff to review",
      description: "The current session has not recorded changed files or a diff.",
      category: "process"
    });
  }
  if (diff && diff.length > 5000) {
    addFinding(findings, {
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
    addFinding(findings, {
      severity: "critical",
      title: "Potential secret introduced",
      description: "The diff appears to add a credential-like value or API key reference.",
      recommendation:
        "Remove the secret and load credentials from configured environment variables.",
      category: "security"
    });
  }
  const manifestChanges = reviewedFiles.filter(isPackageManifest);
  const lockfileTouched = reviewedFiles.some(isLockfile);
  if (manifestChanges.length > 0 && !lockfileTouched) {
    addFinding(findings, {
      severity: "medium",
      title: "Package manifest changed without lockfile update",
      description:
        "A package manifest changed, but the reviewed file set does not include the matching dependency lockfile.",
      file: manifestChanges[0],
      recommendation:
        "Update and review the lockfile, or confirm the package.json change does not affect dependency resolution.",
      category: "maintainability"
    });
  }

  for (const file of diffFiles) {
    const addedText = file.addedLines.map((line) => line.text).join("\n");
    const firstAddedLine = file.addedLines.find((line) => line.line !== undefined)?.line;

    if (isTestFile(file.path) && /\b(?:describe|it|test)\.only\s*\(/.test(addedText)) {
      addFinding(findings, {
        severity: "high",
        title: "Focused test committed",
        description: "The diff adds a focused test marker that can suppress the rest of the suite.",
        file: file.path,
        line: firstAddedLine,
        recommendation: "Remove .only before shipping.",
        category: "testing"
      });
    }

    if (isTestFile(file.path) && /\b(?:describe|it|test)\.skip\s*\(/.test(addedText)) {
      addFinding(findings, {
        severity: "medium",
        title: "Skipped test committed",
        description: "The diff adds a skipped test, which may hide an unverified behavior change.",
        file: file.path,
        line: firstAddedLine,
        recommendation: "Prefer fixing the test or documenting an explicit temporary skip owner.",
        category: "testing"
      });
    }

    if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(addedText)) {
      addFinding(findings, {
        severity: "high",
        title: "Dynamic code execution introduced",
        description:
          "The diff adds eval-like dynamic execution, which is rarely safe in production.",
        file: file.path,
        line: firstAddedLine,
        recommendation:
          "Replace dynamic execution with explicit parsing or a constrained interpreter.",
        category: "security"
      });
    }

    if (
      /from\s+["']node:child_process["']|from\s+["']child_process["']|require\(["'](?:node:)?child_process["']\)|\b(?:exec|execFile|execSync|spawn|spawnSync)\s*\(/.test(
        addedText
      )
    ) {
      addFinding(findings, {
        severity: "high",
        title: "Host process execution path introduced",
        description:
          "The diff adds child-process execution or command-spawning code that needs hard sandbox and policy enforcement.",
        file: file.path,
        line: firstAddedLine,
        recommendation:
          "Route command execution through the Tool Bus sandbox contract and add focused tests.",
        category: "security"
      });
    }

    if (/\b(?:curl|wget)\b[^\n|]*\|\s*(?:sh|bash|zsh)\b/.test(addedText)) {
      addFinding(findings, {
        severity: "high",
        title: "Pipe-to-shell installer introduced",
        description: "The diff adds a network download piped directly into a shell.",
        file: file.path,
        line: firstAddedLine,
        recommendation:
          "Download, verify integrity, and execute through an auditable installer path.",
        category: "security"
      });
    }

    if (
      /\b(?:localStorage|sessionStorage)\.(?:setItem|getItem)\s*\(\s*["'][^"']*(?:token|secret|key|credential)/i.test(
        addedText
      )
    ) {
      addFinding(findings, {
        severity: "medium",
        title: "Credential-like browser storage usage",
        description:
          "The diff stores or reads a token-like value through browser storage, which is exposed to injected scripts.",
        file: file.path,
        line: firstAddedLine,
        recommendation: "Use an httpOnly cookie or a shorter-lived in-memory credential strategy.",
        category: "security"
      });
    }

    if (
      /Access-Control-Allow-Origin["']?\s*[:=]\s*["']\*["']|origin\s*:\s*["']\*["']/.test(addedText)
    ) {
      addFinding(findings, {
        severity: "medium",
        title: "Broad CORS origin introduced",
        description: "The diff appears to allow all cross-origin callers.",
        file: file.path,
        line: firstAddedLine,
        recommendation: "Restrict origins to the smallest production allowlist.",
        category: "security"
      });
    }

    if (/catch\s*(?:\([^)]*\))?\s*\{\s*\}/.test(addedText)) {
      addFinding(findings, {
        severity: "medium",
        title: "Empty catch block introduced",
        description: "The diff adds an empty catch block that can swallow production failures.",
        file: file.path,
        line: firstAddedLine,
        recommendation: "Log, rethrow, or convert the error into an explicit handled result.",
        category: "correctness"
      });
    }
  }

  const sourceTouched = reviewedFiles.some(isSourceFile);
  const testsTouched = reviewedFiles.some(isTestFile);
  if (sourceTouched && !testsTouched) {
    addFinding(findings, {
      severity: "medium",
      title: "No test file changed",
      description: "Source files changed without a matching test update in the recorded file set.",
      recommendation: "Confirm existing tests cover the behavior or add focused coverage.",
      category: "testing"
    });
  }

  const publicApiChanges = diffFiles.filter(
    (file) =>
      isSourceFile(file.path) &&
      file.addedLines.some((line) =>
        /\bexport\s+(?:async\s+)?(?:class|function|const|let|var|interface|type|enum)\b/.test(
          line.text
        )
      )
  );
  for (const file of publicApiChanges) {
    if (testsTouched && !hasMatchingTestChange(file.path, reviewedFiles)) {
      addFinding(findings, {
        severity: "medium",
        title: "Public API changed without focused test",
        description:
          "An exported source symbol changed, but no nearby or same-stem test file changed in the reviewed set.",
        file: file.path,
        line: file.addedLines.find((line) => line.line !== undefined)?.line,
        recommendation: "Add or update a focused test for the exported behavior.",
        category: "testing"
      });
    }
  }

  const removedTestFiles = diffFiles.filter(
    (file) => isTestFile(file.path) && file.removedLines.length > 0 && file.addedLines.length === 0
  );
  for (const file of removedTestFiles) {
    addFinding(findings, {
      severity: "high",
      title: "Test coverage removed",
      description: "A test file appears to remove coverage without adding replacement lines.",
      file: file.path,
      recommendation:
        "Confirm replacement coverage exists or keep the deleted test behavior covered.",
      category: "testing"
    });
  }

  return findings;
}

function reviewContext(
  filesChanged: string[],
  context: CompiledContext | undefined
): ReviewFinding[] {
  if (!context) {
    return [];
  }
  const findings: ReviewFinding[] = [];
  const changed = new Set(filesChanged.map(normalizeDiffPath));
  const testsChanged = filesChanged.some(isTestFile);
  for (const file of changed) {
    if (!isSourceFile(file)) {
      continue;
    }
    const testMap = context.repository.testMap.find((entry) => entry.sourcePath === file);
    const exportedSymbols = context.repository.symbols.filter(
      (symbol) => symbol.path === file && symbol.exported
    );
    if (exportedSymbols.length > 0 && !testsChanged && (testMap?.testPaths.length ?? 0) === 0) {
      addFinding(findings, {
        severity: "medium",
        title: "Exported source lacks mapped test coverage",
        description:
          "The changed file exports public symbols, but Nexus could not map it to a nearby focused test.",
        file,
        recommendation: "Add or update a focused test near the changed source before shipping.",
        category: "testing"
      });
    }
  }
  return findings;
}

function buildCoverageHints(
  filesChanged: string[],
  context: CompiledContext | undefined
): string[] {
  if (!context) {
    return [];
  }
  const hints = new Set<string>();
  for (const file of filesChanged.map(normalizeDiffPath).filter(isSourceFile)) {
    const entry = context.repository.testMap.find((candidate) => candidate.sourcePath === file);
    if (entry?.testPaths.length) {
      hints.add(`${file}: run or update ${entry.testPaths.join(", ")}`);
    } else if (entry?.command) {
      hints.add(`${file}: verify with ${entry.command}`);
    }
  }
  return [...hints].slice(0, 20);
}

function addFinding(findings: ReviewFinding[], finding: Omit<ReviewFinding, "id">): void {
  findings.push({ ...finding, id: `finding_${findings.length + 1}` });
}

function parseDiffFiles(diff: string | undefined): DiffFileSummary[] {
  if (!diff?.trim()) {
    return [];
  }

  const files: DiffFileSummary[] = [];
  let current: DiffFileSummary | undefined;
  let oldLineNumber: number | undefined;
  let newLineNumber: number | undefined;

  for (const rawLine of diff.split(/\r?\n/)) {
    const gitHeader = /^diff --git a\/(.+) b\/(.+)$/.exec(rawLine);
    if (gitHeader) {
      current = {
        oldPath: normalizeDiffPath(gitHeader[1] ?? ""),
        path: normalizeDiffPath(gitHeader[2] ?? ""),
        addedLines: [],
        removedLines: []
      };
      files.push(current);
      oldLineNumber = undefined;
      newLineNumber = undefined;
      continue;
    }

    if (!current) {
      continue;
    }

    if (rawLine.startsWith("+++ ")) {
      const nextPath = normalizeDiffPath(rawLine.slice(4));
      if (nextPath !== "/dev/null") {
        current.path = nextPath;
      }
      continue;
    }

    if (rawLine.startsWith("--- ")) {
      const previousPath = normalizeDiffPath(rawLine.slice(4));
      if (previousPath !== "/dev/null") {
        current.oldPath = previousPath;
      }
      continue;
    }

    const hunkHeader = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rawLine);
    if (hunkHeader) {
      oldLineNumber = Number(hunkHeader[1]);
      newLineNumber = Number(hunkHeader[2]);
      continue;
    }

    if (rawLine.startsWith("+")) {
      current.addedLines.push({ line: newLineNumber, text: rawLine.slice(1) });
      if (newLineNumber !== undefined) {
        newLineNumber += 1;
      }
      continue;
    }

    if (rawLine.startsWith("-")) {
      current.removedLines.push({ line: oldLineNumber, text: rawLine.slice(1) });
      if (oldLineNumber !== undefined) {
        oldLineNumber += 1;
      }
      continue;
    }

    if (rawLine.startsWith(" ") || rawLine === "") {
      if (oldLineNumber !== undefined) {
        oldLineNumber += 1;
      }
      if (newLineNumber !== undefined) {
        newLineNumber += 1;
      }
    }
  }

  return files.filter((file) => file.path && file.path !== "/dev/null");
}

function normalizeDiffPath(path: string): string {
  const normalized = path.trim().split("\t")[0]?.replace(/^"|"$/g, "") ?? "";
  if (normalized === "/dev/null") {
    return normalized;
  }
  return normalized.replace(/^[ab]\//, "").replace(/\\/g, "/");
}

function isSourceFile(file: string): boolean {
  const normalized = normalizeDiffPath(file);
  return (
    /\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(normalized) &&
    !/\.d\.ts$/.test(normalized) &&
    !isTestFile(normalized)
  );
}

function isTestFile(file: string): boolean {
  const normalized = normalizeDiffPath(file);
  return /(?:^|\/)__tests__\/|\.test\.(?:ts|tsx|js|jsx|mjs|cjs)$|\.spec\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(
    normalized
  );
}

function isPackageManifest(file: string): boolean {
  return basename(file) === "package.json";
}

function isLockfile(file: string): boolean {
  const name = basename(file);
  return (
    name === "pnpm-lock.yaml" ||
    name === "package-lock.json" ||
    name === "yarn.lock" ||
    name === "bun.lockb" ||
    name === "bun.lock"
  );
}

function basename(file: string): string {
  return normalizeDiffPath(file).split("/").at(-1) ?? file;
}

function hasMatchingTestChange(sourceFile: string, reviewedFiles: string[]): boolean {
  const sourceDir = dirname(sourceFile);
  const stem = fileStem(sourceFile);
  return reviewedFiles.some((file) => {
    if (!isTestFile(file)) {
      return false;
    }
    const testDir = dirname(file);
    return fileStem(file) === stem || testDir === sourceDir || testDir.startsWith(`${sourceDir}/`);
  });
}

function dirname(file: string): string {
  const normalized = normalizeDiffPath(file);
  const parts = normalized.split("/");
  parts.pop();
  return parts.join("/");
}

function fileStem(file: string): string {
  return basename(file)
    .replace(/\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)$/, "")
    .replace(/\.(?:ts|tsx|js|jsx|mjs|cjs)$/, "");
}

function dedupeFindings(findings: ReviewFinding[]): ReviewFinding[] {
  const seen = new Set<string>();
  const deduped: ReviewFinding[] = [];
  for (const finding of findings) {
    const key = [
      finding.severity,
      finding.title.toLowerCase(),
      finding.file ?? "",
      finding.line ?? "",
      finding.category ?? ""
    ].join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(finding);
  }
  return deduped;
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
