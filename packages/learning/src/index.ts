import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
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

export type LearningCandidateScope = "project" | "user" | "session";
export type LearningCandidateType = "workflow" | "test-map" | "preference" | "known-failure" | "project-fact";

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
  effectiveMode: Exclude<LearningMode, "active">;
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
}

export class LearningPlane {
  private readonly scanner = new SecretsScanner();
  private readonly userMemoryRoot: string;
  private state: LearningState;

  public constructor(input: { mode: LearningMode; userMemoryRoot?: string }) {
    this.userMemoryRoot = input.userMemoryRoot ?? join(homedir(), ".nexus", "memories");
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
      this.createPackageManagerCandidate(input.context, sourceEventIds),
      this.createVerificationCandidate(input.context, input.commandsRun, sourceEventIds),
      this.createTouchedFilesCandidate(input.filesChanged, input.context, sourceEventIds),
      this.createUserPreferenceCandidate(input.context, sourceEventIds)
    ].filter((candidate): candidate is LearningCandidate => Boolean(candidate));

    const safeCandidates = candidates.map((candidate) => this.applySafety(candidate));
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

    return safeCandidates;
  }

  public async acceptPending(input: {
    sessionId: SessionId;
    eventBus: EventBus;
    cwd: string;
    candidateIds?: LearningCandidateId[];
  }): Promise<MemoryEntry[]> {
    const selectedIds = new Set(input.candidateIds ?? this.state.pendingCandidates.map((candidate) => candidate.id));
    const acceptedCandidates = this.state.pendingCandidates.filter((candidate) => selectedIds.has(candidate.id));
    const rejectedCandidates = this.state.pendingCandidates.filter((candidate) => !selectedIds.has(candidate.id));
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

    for (const [path, scopedEntries] of groupEntriesByPath(input.cwd, this.userMemoryRoot, entries)) {
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
    const selectedIds = new Set(input.candidateIds ?? this.state.pendingCandidates.map((candidate) => candidate.id));
    const rejected = this.state.pendingCandidates.filter((candidate) => selectedIds.has(candidate.id));
    this.state = {
      ...this.state,
      pendingCandidates: this.state.pendingCandidates.filter((candidate) => !selectedIds.has(candidate.id))
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
    const project = await parseMarkdownMemory(projectMemoryPath(cwd), "project");
    const user = await parseMarkdownMemory(userMemoryPath(this.userMemoryRoot), "user");
    const byId = new Map<string, MemoryEntry>();
    for (const entry of [...project, ...user, ...this.state.acceptedMemory]) {
      byId.set(entry.id, entry);
    }
    return [...byId.values()];
  }

  public async readProjectMemory(cwd: string): Promise<string> {
    await assertSafeProjectLearningRoot(cwd);
    return readFile(projectMemoryPath(cwd), "utf8").catch(() => "");
  }

  public async readUserMemory(): Promise<string> {
    return readFile(userMemoryPath(this.userMemoryRoot), "utf8").catch(() => "");
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
      commandsRun.find((item) => /\b(test|typecheck|lint)\b/i.test(item)) ?? context.repository.testCommands[0];
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

  private createTouchedFilesCandidate(
    filesChanged: string[],
    context: CompiledContext,
    sourceEventIds: EventId[]
  ): LearningCandidate | undefined {
    const uniqueFiles = [...new Set(filesChanged)].slice(0, 8);
    if (uniqueFiles.length === 0) {
      return undefined;
    }

    return createCandidate({
      scope: "project",
      type: "test-map",
      text: `Recent implementation touched: ${uniqueFiles.join(", ")}.`,
      confidence: 0.7,
      proposedStoragePath: projectMemoryPath(context.cwd),
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
    const styleHint = context.repository.packageManager === "pnpm" ? "Prefer pnpm commands in this workspace." : undefined;
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
} {
  const root = join(cwd, ".nexus", "learning");
  return {
    projectMemoryPath: join(root, "project-memory.md"),
    testMapPath: join(root, "test-map.json"),
    workflowsPath: join(root, "workflows.json"),
    knownFailuresPath: join(root, "known-failures.json")
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
    await appendMarkdownMemory(projectMemoryPath(input.cwd), "# Project Memory", projectEntries);
    await updateProjectStructuredStores(input.cwd, projectEntries);
  }
  if (userEntries.length > 0) {
    await appendMarkdownMemory(userMemoryPath(input.userMemoryRoot), "# User Memory", userEntries);
  }
}

async function appendMarkdownMemory(path: string, heading: string, entries: MemoryEntry[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const existing = await readFile(path, "utf8").catch(() => `${heading}\n\n`);
  const block = entries.map(formatMemoryEntry).join("\n");
  const separator = existing.endsWith("\n") ? "" : "\n";
  await writeFile(path, `${existing}${separator}${block}\n`, "utf8");
}

async function rewriteMarkdownMemory(cwd: string, userMemoryRoot: string, entries: MemoryEntry[]): Promise<void> {
  const projectEntries = entries.filter((entry) => entry.scope === "project");
  const userEntries = entries.filter((entry) => entry.scope === "user");
  await assertSafeProjectLearningRoot(cwd);
  await writeFile(
    projectMemoryPath(cwd),
    `# Project Memory\n\n${projectEntries.map(formatMemoryEntry).join("\n")}${projectEntries.length > 0 ? "\n" : ""}`,
    "utf8"
  );
  await mkdir(userMemoryRoot, { recursive: true });
  await writeFile(
    userMemoryPath(userMemoryRoot),
    `# User Memory\n\n${userEntries.map(formatMemoryEntry).join("\n")}${userEntries.length > 0 ? "\n" : ""}`,
    "utf8"
  );
}

async function updateProjectStructuredStores(cwd: string, entries: MemoryEntry[]): Promise<void> {
  await assertSafeProjectLearningRoot(cwd);
  const paths = learningStorePaths(cwd);
  await appendJsonStore(paths.workflowsPath, entries.filter((entry) => entry.type === "workflow"));
  await appendJsonStore(paths.testMapPath, entries.filter((entry) => entry.type === "test-map"));
  await appendJsonStore(paths.knownFailuresPath, entries.filter((entry) => entry.type === "known-failure"));
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

async function appendJsonStore(path: string, entries: MemoryEntry[]): Promise<void> {
  if (entries.length === 0) {
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  const existing = await readJsonArray(path);
  const known = new Set(existing.map((entry) => entry.text));
  const next = [
    ...existing,
    ...entries
      .filter((entry) => !known.has(entry.text))
      .map((entry) => ({
        id: entry.id,
        type: entry.type,
        text: entry.text,
        sourceCandidateId: entry.sourceCandidateId,
        createdAt: entry.createdAt
      }))
  ];
  await writeFile(path, `${safeJsonStringify(next)}\n`, "utf8");
}

async function readJsonArray(path: string): Promise<Array<Record<string, string>>> {
  const content = await readFile(path, "utf8").catch(() => "[]");
  try {
    const parsed = JSON.parse(content) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is Record<string, string> => typeof item === "object" && item !== null)
      : [];
  } catch {
    return [];
  }
}

async function parseMarkdownMemory(path: string, scope: LearningCandidateScope): Promise<MemoryEntry[]> {
  const content = await readFile(path, "utf8").catch(() => "");
  return content
    .split(/\r?\n/)
    .map((line) => /^- \[([^\]]+)\] \[([^\]]+)\] (.+)$/.exec(line.trim()))
    .filter((match): match is RegExpExecArray => Boolean(match))
    .map((match) => ({
      id: match[1] as unknown as MemoryId,
      scope,
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
    text: input.text,
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

function effectiveLearningMode(mode: LearningMode): Exclude<LearningMode, "active"> {
  return mode === "active" ? "suggest" : mode;
}

function normalizeMemoryType(value: string): LearningCandidateType {
  if (
    value === "workflow" ||
    value === "test-map" ||
    value === "preference" ||
    value === "known-failure" ||
    value === "project-fact"
  ) {
    return value;
  }
  return "project-fact";
}

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, value));
}
