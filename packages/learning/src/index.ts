import { lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { type CompiledContext } from "@nexus/context";
import { type EventBus, createEvent } from "@nexus/events";
import { SecretsScanner } from "@nexus/security";
import {
  type EventId,
  type LearningCandidateId,
  type LearningMode,
  type MemoryId,
  type SessionId,
  createId,
  nowIso,
  redactString,
  safeJsonStringify
} from "@nexus/shared";
import { safeAtomicWriteText, safeReadTextFile } from "@nexus/storage";

export type LearningCandidateScope = "project" | "user" | "session";
export type LearningCandidateType =
  | "workflow"
  | "test-map"
  | "preference"
  | "known-failure"
  | "project-fact"
  | "eval";

export interface LearningCandidate {
  id: LearningCandidateId;
  scope: LearningCandidateScope;
  type: LearningCandidateType;
  text: string;
  confidence: number;
  sourceEventIds: EventId[];
  sensitive: boolean;
  requiresApproval: boolean;
  proposedStoragePath: string;
  createdAt: string;
}

export interface LearningCandidateDraft {
  scope?: LearningCandidateScope;
  type?: LearningCandidateType;
  text: string;
  confidence?: number;
  sourceEventIds?: EventId[];
}

export interface MemoryEntry {
  id: MemoryId;
  scope: LearningCandidateScope;
  type: LearningCandidateType;
  text: string;
  sourceCandidateId: LearningCandidateId;
  createdAt: string;
}

export interface LearningState {
  mode: LearningMode;
  effectiveMode: LearningMode;
  pendingCandidates: LearningCandidate[];
  acceptedMemory: MemoryEntry[];
}

export interface GenerateCandidatesInput {
  sessionId: SessionId;
  eventBus: EventBus;
  context: CompiledContext;
  commandsRun: string[];
  filesChanged: string[];
  sourceEventIds?: EventId[];
  semanticCandidates?: LearningCandidateDraft[];
}

export class LearningPlane {
  private readonly scanner = new SecretsScanner();
  private readonly userMemoryRoot: string;
  private readonly requireUserConfirmation: boolean;
  private state: LearningState;

  public constructor(input: {
    mode: LearningMode;
    userMemoryRoot?: string;
    requireUserConfirmation?: boolean;
  }) {
    this.userMemoryRoot = input.userMemoryRoot ?? join(homedir(), ".nexus", "memories");
    this.requireUserConfirmation = input.requireUserConfirmation ?? true;
    this.state = {
      mode: input.mode,
      effectiveMode: effectiveLearningMode(input.mode),
      pendingCandidates: [],
      acceptedMemory: []
    };
  }

  public getState(): LearningState {
    return structuredClone(this.state);
  }

  public async generateCandidates(input: GenerateCandidatesInput): Promise<LearningCandidate[]> {
    if (this.state.effectiveMode === "off") {
      return [];
    }

    const sourceEventIds = input.sourceEventIds ?? [];
    const candidates = [
      ...this.createSemanticCandidates(
        input.semanticCandidates ?? [],
        input.context,
        sourceEventIds
      ),
      this.createPackageManagerCandidate(input.context, sourceEventIds),
      this.createVerificationCandidate(input.context, input.commandsRun, sourceEventIds),
      this.createEvalCandidate(
        input.context,
        input.commandsRun,
        input.filesChanged,
        sourceEventIds
      ),
      ...this.createTestMapCandidates(input.filesChanged, input.context, sourceEventIds),
      this.createUserPreferenceCandidate(input.context, sourceEventIds)
    ].filter((candidate): candidate is LearningCandidate => Boolean(candidate));

    const safeCandidates = dedupeCandidates(
      candidates
        .map((candidate) => this.applySafety(candidate))
        .map((candidate) => this.applyApprovalPolicy(candidate)),
      this.state.pendingCandidates
    );
    this.state = {
      ...this.state,
      pendingCandidates: [...this.state.pendingCandidates, ...safeCandidates]
    };

    for (const candidate of safeCandidates) {
      await input.eventBus.publish(
        createEvent({
          sessionId: input.sessionId,
          type: "learning.candidate.created",
          data: { candidate }
        })
      );
    }

    const autoAcceptable = safeCandidates.filter((candidate) => !candidate.requiresApproval);
    if (autoAcceptable.length > 0) {
      await this.acceptPending({
        sessionId: input.sessionId,
        eventBus: input.eventBus,
        cwd: input.context.cwd,
        candidateIds: autoAcceptable.map((candidate) => candidate.id)
      });
    }

    return safeCandidates;
  }

  public async acceptPending(input: {
    sessionId: SessionId;
    eventBus: EventBus;
    cwd: string;
    candidateIds?: LearningCandidateId[];
  }): Promise<MemoryEntry[]> {
    const selectedIds = new Set(
      input.candidateIds ?? this.state.pendingCandidates.map((candidate) => candidate.id)
    );
    const acceptedCandidates = this.state.pendingCandidates.filter((candidate) =>
      selectedIds.has(candidate.id)
    );
    const rejectedCandidates = this.state.pendingCandidates.filter(
      (candidate) => !selectedIds.has(candidate.id)
    );
    const entries = acceptedCandidates.map((candidate) => candidateToMemoryEntry(candidate));

    await writeMemoryEntries({
      cwd: input.cwd,
      userMemoryRoot: this.userMemoryRoot,
      entries
    });

    this.state = {
      ...this.state,
      pendingCandidates: rejectedCandidates,
      acceptedMemory: [...this.state.acceptedMemory, ...entries]
    };

    for (const candidate of acceptedCandidates) {
      await input.eventBus.publish(
        createEvent({
          sessionId: input.sessionId,
          type: "learning.candidate.accepted",
          data: { candidateId: candidate.id }
        })
      );
    }

    for (const [path, scopedEntries] of groupEntriesByPath(
      input.cwd,
      this.userMemoryRoot,
      entries
    )) {
      await input.eventBus.publish(
        createEvent({
          sessionId: input.sessionId,
          type: "memory.written",
          data: {
            path,
            entries: scopedEntries
          }
        })
      );
    }

    return entries;
  }

  public async rejectPending(input: {
    sessionId: SessionId;
    eventBus: EventBus;
    candidateIds?: LearningCandidateId[];
  }): Promise<LearningCandidate[]> {
    const selectedIds = new Set(
      input.candidateIds ?? this.state.pendingCandidates.map((candidate) => candidate.id)
    );
    const rejected = this.state.pendingCandidates.filter((candidate) =>
      selectedIds.has(candidate.id)
    );
    this.state = {
      ...this.state,
      pendingCandidates: this.state.pendingCandidates.filter(
        (candidate) => !selectedIds.has(candidate.id)
      )
    };

    for (const candidate of rejected) {
      await input.eventBus.publish(
        createEvent({
          sessionId: input.sessionId,
          type: "learning.candidate.rejected",
          data: { candidateId: candidate.id }
        })
      );
    }

    return rejected;
  }

  public async editCandidate(input: {
    candidateId: LearningCandidateId;
    text: string;
  }): Promise<LearningCandidate | undefined> {
    let edited: LearningCandidate | undefined;
    this.state = {
      ...this.state,
      pendingCandidates: this.state.pendingCandidates.map((candidate) => {
        if (candidate.id !== input.candidateId) {
          return candidate;
        }
        edited = this.applySafety({ ...candidate, text: input.text });
        return edited;
      })
    };
    return edited;
  }

  public async editMemory(input: {
    sessionId: SessionId;
    eventBus: EventBus;
    cwd: string;
    memoryId: MemoryId;
    text: string;
  }): Promise<MemoryEntry | undefined> {
    const memories = await this.listMemories(input.cwd);
    let edited: MemoryEntry | undefined;
    const nextMemory = memories.map((entry) => {
      if (entry.id !== input.memoryId) {
        return entry;
      }
      edited = { ...entry, text: redactString(input.text) };
      return edited;
    });
    this.state = {
      ...this.state,
      acceptedMemory: nextMemory
    };
    if (edited) {
      await rewriteMarkdownMemory(input.cwd, this.userMemoryRoot, nextMemory);
      await input.eventBus.publish(
        createEvent({
          sessionId: input.sessionId,
          type: "memory.updated",
          data: { memoryId: input.memoryId }
        })
      );
    }
    return edited;
  }

  public async deleteMemory(input: {
    sessionId: SessionId;
    eventBus: EventBus;
    cwd: string;
    memoryId: MemoryId;
  }): Promise<MemoryEntry | undefined> {
    const memories = await this.listMemories(input.cwd);
    const deleted = memories.find((entry) => entry.id === input.memoryId);
    if (!deleted) {
      return undefined;
    }
    const nextMemory = memories.filter((entry) => entry.id !== input.memoryId);
    this.state = {
      ...this.state,
      acceptedMemory: nextMemory
    };
    await rewriteMarkdownMemory(input.cwd, this.userMemoryRoot, nextMemory);
    await input.eventBus.publish(
      createEvent({
        sessionId: input.sessionId,
        type: "memory.deleted",
        data: { memoryId: input.memoryId }
      })
    );
    return deleted;
  }

  public async listMemories(cwd: string): Promise<MemoryEntry[]> {
    await assertSafeProjectLearningRoot(cwd);
    const project = await parseMarkdownMemory({
      path: projectMemoryPath(cwd),
      scope: "project",
      allowedRoot: join(cwd, ".nexus"),
      workspaceRoot: cwd,
      rootDescription: ".nexus learning storage"
    });
    const user = await parseMarkdownMemory({
      path: userMemoryPath(this.userMemoryRoot),
      scope: "user",
      allowedRoot: this.userMemoryRoot,
      workspaceRoot: this.userMemoryRoot,
      rootDescription: "user memory storage"
    });
    const byId = new Map<string, MemoryEntry>();
    for (const entry of [...project, ...user, ...this.state.acceptedMemory]) {
      byId.set(entry.id, entry);
    }
    return [...byId.values()];
  }

  public async readProjectMemory(cwd: string): Promise<string> {
    await assertSafeProjectLearningRoot(cwd);
    return (
      (await safeReadTextFile({
        path: projectMemoryPath(cwd),
        allowedRoot: join(cwd, ".nexus"),
        workspaceRoot: cwd,
        rootDescription: ".nexus learning storage"
      })) ?? ""
    );
  }

  public async readUserMemory(): Promise<string> {
    return (
      (await safeReadTextFile({
        path: userMemoryPath(this.userMemoryRoot),
        allowedRoot: this.userMemoryRoot,
        workspaceRoot: this.userMemoryRoot,
        rootDescription: "user memory storage"
      })) ?? ""
    );
  }

  private createSemanticCandidates(
    drafts: LearningCandidateDraft[],
    context: CompiledContext,
    fallbackSourceEventIds: EventId[]
  ): LearningCandidate[] {
    return drafts
      .map((draft) => {
        const text = normalizeCandidateText(draft.text);
        if (!text) {
          return undefined;
        }
        const scope = normalizeCandidateScope(draft.scope);
        return createCandidate({
          scope,
          type: normalizeMemoryType(draft.type ?? "project-fact"),
          text,
          confidence: draft.confidence ?? 0.75,
          proposedStoragePath:
            scope === "user" ? userMemoryPath(this.userMemoryRoot) : projectMemoryPath(context.cwd),
          sourceEventIds:
            draft.sourceEventIds && draft.sourceEventIds.length > 0
              ? draft.sourceEventIds
              : fallbackSourceEventIds
        });
      })
      .filter((candidate): candidate is LearningCandidate => Boolean(candidate));
  }

  private createPackageManagerCandidate(
    context: CompiledContext,
    sourceEventIds: EventId[]
  ): LearningCandidate | undefined {
    if (context.repository.packageManager === "unknown") {
      return undefined;
    }

    return createCandidate({
      scope: "project",
      type: "project-fact",
      text: `Project uses ${context.repository.packageManager} as its package manager.`,
      confidence: 0.9,
      proposedStoragePath: projectMemoryPath(context.cwd),
      sourceEventIds
    });
  }

  private createVerificationCandidate(
    context: CompiledContext,
    commandsRun: string[],
    sourceEventIds: EventId[]
  ): LearningCandidate | undefined {
    const command =
      commandsRun.find((item) => /\b(test|typecheck|lint)\b/i.test(item)) ??
      context.repository.testCommands[0];
    if (!command) {
      return undefined;
    }

    return createCandidate({
      scope: "project",
      type: "workflow",
      text: `Use \`${command}\` for project verification when relevant.`,
      confidence: commandsRun.includes(command) ? 0.85 : 0.65,
      proposedStoragePath: projectMemoryPath(context.cwd),
      sourceEventIds
    });
  }

  private createTestMapCandidates(
    filesChanged: string[],
    context: CompiledContext,
    sourceEventIds: EventId[]
  ): LearningCandidate[] {
    return [...new Set(filesChanged)]
      .filter(isSourceFile)
      .slice(0, 5)
      .map((file) => {
        const likelyTests = findLikelyTestsForSource(file, context);
        const verificationCommand = context.repository.testCommands[0];
        const text =
          likelyTests.length > 0
            ? `When changing ${file}, run or update ${likelyTests.join(", ")}.`
            : `When changing ${file}, verify behavior with ${
                verificationCommand ? `\`${verificationCommand}\`` : "the nearest focused test"
              } and add nearby coverage if behavior changes.`;
        return createCandidate({
          scope: "project",
          type: "test-map",
          text,
          confidence: likelyTests.length > 0 ? 0.82 : 0.68,
          proposedStoragePath: projectMemoryPath(context.cwd),
          sourceEventIds
        });
      });
  }

  private createEvalCandidate(
    context: CompiledContext,
    commandsRun: string[],
    filesChanged: string[],
    sourceEventIds: EventId[]
  ): LearningCandidate | undefined {
    const sourceFile = filesChanged.find(isSourceFile);
    const verificationCommand =
      commandsRun.find((command) => /\b(test|verify|coverage)\b/i.test(command)) ??
      context.repository.testCommands[0];
    if (!sourceFile || !verificationCommand) {
      return undefined;
    }
    const mappedTests = context.repository.testMap.find((entry) => entry.sourcePath === sourceFile);
    return createCandidate({
      scope: "project",
      type: "eval",
      text: `Create an eval fixture for ${sourceFile} using ${mappedTests?.testPaths.join(", ") || verificationCommand} when this workflow regresses.`,
      confidence: mappedTests?.testPaths.length ? 0.78 : 0.62,
      proposedStoragePath: learningStorePaths(context.cwd).evalsPath,
      sourceEventIds
    });
  }

  private createUserPreferenceCandidate(
    context: CompiledContext,
    sourceEventIds: EventId[]
  ): LearningCandidate | undefined {
    if (context.memories.user.trim().length > 0) {
      return undefined;
    }
    const styleHint =
      context.repository.packageManager === "pnpm"
        ? "Prefer pnpm commands in this workspace."
        : undefined;
    if (!styleHint) {
      return undefined;
    }
    return createCandidate({
      scope: "user",
      type: "preference",
      text: styleHint,
      confidence: 0.55,
      proposedStoragePath: userMemoryPath(this.userMemoryRoot),
      sourceEventIds
    });
  }

  private applySafety(candidate: LearningCandidate): LearningCandidate {
    const findings = this.scanner.scan(candidate.text);
    const pathSensitive = candidate.text.includes(".env") || candidate.text.includes(".ssh");
    if (findings.length === 0 && !pathSensitive) {
      return candidate;
    }

    return {
      ...candidate,
      text: redactString(candidate.text),
      sensitive: true,
      requiresApproval: true,
      confidence: Math.min(candidate.confidence, 0.5)
    };
  }

  private applyApprovalPolicy(candidate: LearningCandidate): LearningCandidate {
    if (
      candidate.sensitive ||
      this.requireUserConfirmation ||
      this.state.mode !== "active" ||
      candidate.scope === "user" ||
      candidate.confidence < 0.8
    ) {
      return { ...candidate, requiresApproval: true };
    }

    return { ...candidate, requiresApproval: false };
  }
}

export function projectMemoryPath(cwd: string): string {
  return join(cwd, ".nexus", "learning", "project-memory.md");
}

export function userMemoryPath(userMemoryRoot = join(homedir(), ".nexus", "memories")): string {
  return join(userMemoryRoot, "user-memory.md");
}

export function learningStorePaths(cwd: string): {
  projectMemoryPath: string;
  testMapPath: string;
  workflowsPath: string;
  knownFailuresPath: string;
  evalsPath: string;
  scorecardPath: string;
} {
  const root = join(cwd, ".nexus", "learning");
  return {
    projectMemoryPath: join(root, "project-memory.md"),
    testMapPath: join(root, "test-map.json"),
    workflowsPath: join(root, "workflows.json"),
    knownFailuresPath: join(root, "known-failures.json"),
    evalsPath: join(root, "evals.json"),
    scorecardPath: join(root, "scorecard.json")
  };
}

async function writeMemoryEntries(input: {
  cwd: string;
  userMemoryRoot: string;
  entries: MemoryEntry[];
}): Promise<void> {
  const projectEntries = input.entries.filter((entry) => entry.scope === "project");
  const userEntries = input.entries.filter((entry) => entry.scope === "user");

  if (projectEntries.length > 0) {
    await assertSafeProjectLearningRoot(input.cwd);
    await appendMarkdownMemory({
      path: projectMemoryPath(input.cwd),
      heading: "# Project Memory",
      entries: projectEntries,
      allowedRoot: join(input.cwd, ".nexus"),
      workspaceRoot: input.cwd,
      rootDescription: ".nexus learning storage"
    });
    await updateProjectStructuredStores(input.cwd, projectEntries);
  }
  if (userEntries.length > 0) {
    await appendMarkdownMemory({
      path: userMemoryPath(input.userMemoryRoot),
      heading: "# User Memory",
      entries: userEntries,
      allowedRoot: input.userMemoryRoot,
      workspaceRoot: input.userMemoryRoot,
      rootDescription: "user memory storage"
    });
  }
}

async function appendMarkdownMemory(input: {
  path: string;
  heading: string;
  entries: MemoryEntry[];
  allowedRoot: string;
  workspaceRoot: string;
  rootDescription: string;
}): Promise<void> {
  const existing =
    (await safeReadTextFile({
      path: input.path,
      allowedRoot: input.allowedRoot,
      workspaceRoot: input.workspaceRoot,
      rootDescription: input.rootDescription
    })) ?? `${input.heading}\n\n`;
  const block = input.entries.map(formatMemoryEntry).join("\n");
  const separator = existing.endsWith("\n") ? "" : "\n";
  await safeAtomicWriteText({
    path: input.path,
    allowedRoot: input.allowedRoot,
    workspaceRoot: input.workspaceRoot,
    content: `${existing}${separator}${block}\n`,
    rootDescription: input.rootDescription
  });
}

async function rewriteMarkdownMemory(
  cwd: string,
  userMemoryRoot: string,
  entries: MemoryEntry[]
): Promise<void> {
  const projectEntries = entries.filter((entry) => entry.scope === "project");
  const userEntries = entries.filter((entry) => entry.scope === "user");
  await assertSafeProjectLearningRoot(cwd);
  await safeAtomicWriteText({
    path: projectMemoryPath(cwd),
    allowedRoot: join(cwd, ".nexus"),
    workspaceRoot: cwd,
    content: `# Project Memory\n\n${projectEntries.map(formatMemoryEntry).join("\n")}${projectEntries.length > 0 ? "\n" : ""}`,
    rootDescription: ".nexus learning storage"
  });
  await safeAtomicWriteText({
    path: userMemoryPath(userMemoryRoot),
    allowedRoot: userMemoryRoot,
    workspaceRoot: userMemoryRoot,
    content: `# User Memory\n\n${userEntries.map(formatMemoryEntry).join("\n")}${userEntries.length > 0 ? "\n" : ""}`,
    rootDescription: "user memory storage"
  });
}

async function updateProjectStructuredStores(cwd: string, entries: MemoryEntry[]): Promise<void> {
  await assertSafeProjectLearningRoot(cwd);
  const paths = learningStorePaths(cwd);
  const storageRoot = join(cwd, ".nexus");
  const storageContext = {
    allowedRoot: storageRoot,
    workspaceRoot: cwd,
    rootDescription: ".nexus learning storage"
  };
  await appendJsonStore({
    path: paths.workflowsPath,
    entries: entries.filter((entry) => entry.type === "workflow"),
    ...storageContext
  });
  await appendJsonStore({
    path: paths.testMapPath,
    entries: entries.filter((entry) => entry.type === "test-map"),
    ...storageContext
  });
  await appendJsonStore({
    path: paths.knownFailuresPath,
    entries: entries.filter((entry) => entry.type === "known-failure"),
    ...storageContext
  });
  await appendJsonStore({
    path: paths.evalsPath,
    entries: entries.filter((entry) => entry.type === "eval"),
    ...storageContext
  });
  await appendJsonStore({ path: paths.scorecardPath, entries, ...storageContext });
}

async function assertSafeProjectLearningRoot(cwd: string): Promise<void> {
  const workspaceRoot = resolve(cwd);
  const realWorkspaceRoot = await realpath(workspaceRoot).catch(() => workspaceRoot);
  const nexusRoot = join(workspaceRoot, ".nexus");
  const metadata = await lstat(nexusRoot).catch(() => undefined);
  if (!metadata) {
    return;
  }
  if (metadata.isSymbolicLink()) {
    throw new Error(".nexus learning storage must not be a symlink.");
  }
  const realNexusRoot = await realpath(nexusRoot).catch(() => nexusRoot);
  if (!isInside(realNexusRoot, realWorkspaceRoot)) {
    throw new Error(".nexus learning storage resolves outside the workspace.");
  }
}

function isInside(target: string, root: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

async function appendJsonStore(input: {
  path: string;
  entries: MemoryEntry[];
  allowedRoot: string;
  workspaceRoot: string;
  rootDescription: string;
}): Promise<void> {
  if (input.entries.length === 0) {
    return;
  }
  const existing = await readJsonArray({
    path: input.path,
    allowedRoot: input.allowedRoot,
    workspaceRoot: input.workspaceRoot,
    rootDescription: input.rootDescription
  });
  const known = new Set(existing.map((entry) => entry.text));
  const next = [
    ...existing,
    ...input.entries
      .filter((entry) => !known.has(entry.text))
      .map((entry) => ({
        id: entry.id,
        type: entry.type,
        text: entry.text,
        sourceCandidateId: entry.sourceCandidateId,
        createdAt: entry.createdAt
      }))
  ];
  await safeAtomicWriteText({
    path: input.path,
    allowedRoot: input.allowedRoot,
    workspaceRoot: input.workspaceRoot,
    content: `${safeJsonStringify(next)}\n`,
    rootDescription: input.rootDescription
  });
}

async function readJsonArray(input: {
  path: string;
  allowedRoot: string;
  workspaceRoot: string;
  rootDescription: string;
}): Promise<Array<Record<string, string>>> {
  const content =
    (await safeReadTextFile({
      path: input.path,
      allowedRoot: input.allowedRoot,
      workspaceRoot: input.workspaceRoot,
      rootDescription: input.rootDescription
    })) ?? "[]";
  try {
    const parsed = JSON.parse(content) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (item): item is Record<string, string> => typeof item === "object" && item !== null
        )
      : [];
  } catch {
    return [];
  }
}

async function parseMarkdownMemory(input: {
  path: string;
  scope: LearningCandidateScope;
  allowedRoot: string;
  workspaceRoot: string;
  rootDescription: string;
}): Promise<MemoryEntry[]> {
  const content =
    (await safeReadTextFile({
      path: input.path,
      allowedRoot: input.allowedRoot,
      workspaceRoot: input.workspaceRoot,
      rootDescription: input.rootDescription
    })) ?? "";
  return content
    .split(/\r?\n/)
    .map((line) => /^- \[([^\]]+)\] \[([^\]]+)\] (.+)$/.exec(line.trim()))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .map((match) => ({
      id: match[1] as unknown as MemoryId,
      scope: input.scope,
      type: normalizeMemoryType(match[2] ?? "project-fact"),
      text: match[3] ?? "",
      sourceCandidateId: "learn_persisted" as LearningCandidateId,
      createdAt: nowIso()
    }));
}

function formatMemoryEntry(entry: MemoryEntry): string {
  return `- [${entry.id}] [${entry.type}] ${entry.text}`;
}

function groupEntriesByPath(
  cwd: string,
  userMemoryRoot: string,
  entries: MemoryEntry[]
): Array<[string, MemoryEntry[]]> {
  const groups = new Map<string, MemoryEntry[]>();
  for (const entry of entries) {
    const path = entry.scope === "user" ? userMemoryPath(userMemoryRoot) : projectMemoryPath(cwd);
    groups.set(path, [...(groups.get(path) ?? []), entry]);
  }
  return [...groups.entries()];
}

function createCandidate(input: {
  scope: LearningCandidateScope;
  type: LearningCandidateType;
  text: string;
  confidence: number;
  proposedStoragePath: string;
  sourceEventIds: EventId[];
}): LearningCandidate {
  return {
    id: createId("learn") as unknown as LearningCandidateId,
    scope: input.scope,
    type: input.type,
    text: normalizeCandidateText(input.text),
    confidence: clampConfidence(input.confidence),
    sourceEventIds: input.sourceEventIds,
    sensitive: false,
    requiresApproval: true,
    proposedStoragePath: input.proposedStoragePath,
    createdAt: nowIso()
  };
}

function candidateToMemoryEntry(candidate: LearningCandidate): MemoryEntry {
  return {
    id: createId("mem") as unknown as MemoryId,
    scope: candidate.scope,
    type: candidate.type,
    text: candidate.text,
    sourceCandidateId: candidate.id,
    createdAt: nowIso()
  };
}

function effectiveLearningMode(mode: LearningMode): LearningMode {
  return mode;
}

function normalizeCandidateScope(value: unknown): LearningCandidateScope {
  if (value === "project" || value === "user" || value === "session") {
    return value;
  }
  return "project";
}

function normalizeMemoryType(value: string): LearningCandidateType {
  if (
    value === "workflow" ||
    value === "test-map" ||
    value === "preference" ||
    value === "known-failure" ||
    value === "project-fact" ||
    value === "eval"
  ) {
    return value;
  }
  return "project-fact";
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function normalizeCandidateText(text: string): string {
  return text.trim().replace(/\s+/g, " ").slice(0, 700);
}

function dedupeCandidates(
  candidates: LearningCandidate[],
  pendingCandidates: LearningCandidate[]
): LearningCandidate[] {
  const seen = new Set(
    pendingCandidates.map((candidate) =>
      [candidate.scope, candidate.type, normalizeCandidateText(candidate.text).toLowerCase()].join(
        "|"
      )
    )
  );
  const deduped: LearningCandidate[] = [];
  for (const candidate of candidates) {
    const key = [
      candidate.scope,
      candidate.type,
      normalizeCandidateText(candidate.text).toLowerCase()
    ].join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(candidate);
  }
  return deduped;
}

function isSourceFile(file: string): boolean {
  return /\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(file) && !/\.d\.ts$/.test(file) && !isTestFile(file);
}

function isTestFile(file: string): boolean {
  return /(?:^|[/\\])__tests__[/\\]|\.test\.(?:ts|tsx|js|jsx|mjs|cjs)$|\.spec\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(
    file
  );
}

function findLikelyTestsForSource(file: string, context: CompiledContext): string[] {
  const normalized = normalizePath(file);
  const directory = pathDirectory(normalized);
  const stem = pathStem(normalized);
  const repoFiles = new Set(
    context.repository.repoMap.files.map((entry) => normalizePath(entry.path))
  );
  const extensions = [".test.ts", ".spec.ts", ".test.tsx", ".spec.tsx", ".test.js", ".spec.js"];
  const directCandidates = extensions.flatMap((extension) => [
    `${directory}/${stem}${extension}`.replace(/^\//, ""),
    `${directory}/__tests__/${stem}${extension}`.replace(/^\//, "")
  ]);
  const existing = directCandidates.filter((candidate) => repoFiles.has(candidate));
  if (existing.length > 0) {
    return existing.slice(0, 3);
  }
  return [...repoFiles]
    .filter((candidate) => isTestFile(candidate) && pathStem(candidate) === stem)
    .slice(0, 3);
}

function normalizePath(file: string): string {
  return file.replace(/\\/g, "/");
}

function pathDirectory(file: string): string {
  const parts = normalizePath(file).split("/");
  parts.pop();
  return parts.join("/");
}

function pathStem(file: string): string {
  const base = normalizePath(file).split("/").at(-1) ?? file;
  return base
    .replace(/\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)$/, "")
    .replace(/\.(?:ts|tsx|js|jsx|mjs|cjs)$/, "");
}
