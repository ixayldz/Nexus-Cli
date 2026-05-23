import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { type SessionId, safeJsonStringify } from "@nexus/shared";

export interface SessionManifest {
  sessionId: SessionId;
  parentSessionId?: SessionId;
  startedAt: string;
  completedAt?: string;
  cwd: string;
  mode: "interactive" | "non-interactive";
  model?: string;
  modelProvider?: string;
  sandboxMode?: string;
  approvalPolicy?: string;
  status?: "running" | "completed" | "stopped";
  eventLogPath: string;
  filesChanged: string[];
  commandsRun: string[];
  verificationStatus?: "passed" | "failed" | "skipped";
  reviewStatus?: "passed" | "warnings" | "failed";
  sdlcStages?: string[];
  learningCandidateCount?: number;
  resumeReplay?: {
    replayedAt: string;
    replayedEventCount: number;
    transcriptMessageCount: number;
    sdlcStageCount: number;
    learningCandidateCount: number;
  };
  artifacts?: {
    finalAnswerPath: string;
    diffPatchPath: string;
    planPath: string;
    contextSummaryPath: string;
    verificationPath: string;
    reviewPath: string;
    shipPath: string;
    rollbackPath: string;
    metricsPath: string;
    evalReportPath: string;
    providerSmokePath: string;
    learningCandidatesPath: string;
  };
}

export interface SessionStorage {
  cwd: string;
  projectStorageRoot: string;
  runDirectory: string;
  eventLogPath: string;
  manifestPath: string;
  artifacts: {
    finalAnswerPath: string;
    diffPatchPath: string;
    planPath: string;
    contextSummaryPath: string;
    verificationPath: string;
    reviewPath: string;
    shipPath: string;
    rollbackPath: string;
    metricsPath: string;
    evalReportPath: string;
    providerSmokePath: string;
    learningCandidatesPath: string;
  };
  writeManifest(manifest: SessionManifest): Promise<void>;
  readManifest(): Promise<SessionManifest>;
  writeArtifact(name: keyof SessionStorage["artifacts"], content: string): Promise<void>;
}

export interface SafeAtomicWriteTextInput {
  path: string;
  allowedRoot: string;
  workspaceRoot: string;
  content: string;
  rootDescription?: string;
}

export interface SafeReadTextFileInput {
  path: string;
  allowedRoot: string;
  workspaceRoot: string;
  rootDescription?: string;
}

export async function safeAtomicWriteText(input: SafeAtomicWriteTextInput): Promise<void> {
  const workspaceRoot = resolve(input.workspaceRoot);
  const allowedRoot = resolve(input.allowedRoot);
  const targetPath = resolve(input.path);
  const rootDescription = input.rootDescription ?? "storage root";

  if (!isInside(allowedRoot, workspaceRoot)) {
    throw new Error(`${rootDescription} must be inside the workspace.`);
  }
  if (!isInside(targetPath, allowedRoot)) {
    throw new Error("Write target escapes the allowed storage root.");
  }

  await mkdir(allowedRoot, { recursive: true });
  await assertDirectoryInsideWorkspace(workspaceRoot, allowedRoot, rootDescription);

  const parent = dirname(targetPath);
  await mkdir(parent, { recursive: true });
  await assertDirectoryInsideWorkspace(workspaceRoot, parent, "write target parent");

  const realAllowedRoot = await realpath(allowedRoot).catch(() => allowedRoot);
  const realParent = await realpath(parent).catch(() => parent);
  if (!isInside(realParent, realAllowedRoot)) {
    throw new Error("Write target parent resolves outside the allowed storage root.");
  }

  const targetMetadata = await lstat(targetPath).catch(() => undefined);
  if (targetMetadata?.isSymbolicLink()) {
    throw new Error("Write target must not be a symlink.");
  }

  const tempPath = join(parent, `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, input.content, { encoding: "utf8", flag: "wx" });
    await rename(tempPath, targetPath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function safeReadTextFile(input: SafeReadTextFileInput): Promise<string | undefined> {
  const workspaceRoot = resolve(input.workspaceRoot);
  const allowedRoot = resolve(input.allowedRoot);
  const targetPath = resolve(input.path);
  const rootDescription = input.rootDescription ?? "storage root";

  if (!isInside(allowedRoot, workspaceRoot)) {
    throw new Error(`${rootDescription} must be inside the workspace.`);
  }
  if (!isInside(targetPath, allowedRoot)) {
    throw new Error("Read target escapes the allowed storage root.");
  }

  await assertOptionalDirectoryInsideWorkspace(workspaceRoot, allowedRoot, rootDescription);
  await assertOptionalDirectoryInsideWorkspace(
    workspaceRoot,
    dirname(targetPath),
    "read target parent"
  );

  const realAllowedRoot = await realpath(allowedRoot).catch(() => allowedRoot);
  const realParent = await realpath(dirname(targetPath)).catch(() => dirname(targetPath));
  if (!isInside(realParent, realAllowedRoot)) {
    throw new Error("Read target parent resolves outside the allowed storage root.");
  }

  const targetMetadata = await lstat(targetPath).catch(() => undefined);
  if (!targetMetadata) {
    return undefined;
  }
  if (targetMetadata.isSymbolicLink()) {
    throw new Error("Read target must not be a symlink.");
  }
  if (!targetMetadata.isFile()) {
    throw new Error("Read target must be a file.");
  }
  return readFile(targetPath, "utf8");
}

export async function readSessionManifest(input: {
  cwd: string;
  sessionId: SessionId;
}): Promise<SessionManifest> {
  const storage = await createSessionStorage(input);
  return storage.readManifest();
}

export async function listSessionManifests(input: { cwd: string }): Promise<SessionManifest[]> {
  const cwd = resolve(input.cwd);
  const runsRoot = join(cwd, ".nexus", "runs");
  const entries = await readdir(runsRoot, { withFileTypes: true }).catch(() => []);
  const manifests: SessionManifest[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const content = await readFile(join(runsRoot, entry.name, "manifest.json"), "utf8").catch(
      () => undefined
    );
    if (!content) {
      continue;
    }
    try {
      manifests.push(JSON.parse(content) as SessionManifest);
    } catch {
      continue;
    }
  }
  return manifests.sort((left, right) => right.startedAt.localeCompare(left.startedAt));
}

export async function createSessionStorage(input: {
  cwd: string;
  sessionId: SessionId;
}): Promise<SessionStorage> {
  const cwd = resolve(input.cwd);
  const sessionId = assertValidSessionId(input.sessionId);
  const projectStorageRoot = join(cwd, ".nexus");
  await assertSafeProjectStorageRoot(cwd, projectStorageRoot);
  const runDirectory = join(projectStorageRoot, "runs", sessionId);
  await assertOptionalDirectoryInsideWorkspace(
    cwd,
    join(projectStorageRoot, "runs"),
    ".nexus runs directory"
  );
  const eventLogPath = join(runDirectory, "events.jsonl");
  const manifestPath = join(runDirectory, "manifest.json");
  const artifacts = {
    finalAnswerPath: join(runDirectory, "final.md"),
    diffPatchPath: join(runDirectory, "diff.patch"),
    planPath: join(runDirectory, "plan.json"),
    contextSummaryPath: join(runDirectory, "context-summary.json"),
    verificationPath: join(runDirectory, "verification.json"),
    reviewPath: join(runDirectory, "review.json"),
    shipPath: join(runDirectory, "ship.json"),
    rollbackPath: join(runDirectory, "rollback.json"),
    metricsPath: join(runDirectory, "metrics.json"),
    evalReportPath: join(runDirectory, "eval-report.json"),
    providerSmokePath: join(runDirectory, "provider-smoke.json"),
    learningCandidatesPath: join(runDirectory, "learning-candidates.json")
  };

  await mkdir(runDirectory, { recursive: true });
  await assertDirectoryInsideWorkspace(cwd, runDirectory, "session run directory");

  return {
    cwd,
    projectStorageRoot,
    runDirectory,
    eventLogPath,
    manifestPath,
    artifacts,
    async writeManifest(manifest: SessionManifest): Promise<void> {
      await safeWriteFile(manifestPath, `${safeJsonStringify(manifest)}\n`, runDirectory, cwd);
    },
    async readManifest(): Promise<SessionManifest> {
      return JSON.parse(await readFile(manifestPath, "utf8")) as SessionManifest;
    },
    async writeArtifact(name: keyof SessionStorage["artifacts"], content: string): Promise<void> {
      await safeWriteFile(artifacts[name], content, runDirectory, cwd);
    }
  };
}

function assertValidSessionId(sessionId: SessionId): string {
  const value = String(sessionId);
  if (!/^nx_[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error("Invalid session id. Session ids must match ^nx_[A-Za-z0-9_-]{1,128}$.");
  }
  return value;
}

async function safeWriteFile(
  filePath: string,
  content: string,
  allowedRoot: string,
  workspaceRoot: string
): Promise<void> {
  await safeAtomicWriteText({
    path: filePath,
    allowedRoot,
    workspaceRoot,
    content,
    rootDescription: "session run directory"
  });
}

async function assertSafeProjectStorageRoot(
  cwd: string,
  projectStorageRoot: string
): Promise<void> {
  const root = resolve(cwd);
  const realRoot = await realpath(root).catch(() => root);
  const metadata = await lstat(projectStorageRoot).catch(() => undefined);
  if (!metadata) {
    return;
  }
  if (metadata.isSymbolicLink()) {
    throw new Error(".nexus project storage must not be a symlink.");
  }
  const realStorageRoot = await realpath(projectStorageRoot).catch(() => projectStorageRoot);
  if (!isInside(realStorageRoot, realRoot)) {
    throw new Error(".nexus project storage resolves outside the workspace.");
  }
}

async function assertDirectoryInsideWorkspace(
  workspaceRoot: string,
  directory: string,
  description: string
): Promise<void> {
  const metadata = await lstat(directory).catch(() => undefined);
  if (metadata?.isSymbolicLink()) {
    throw new Error(`${description} must not be a symlink.`);
  }
  const realWorkspaceRoot = await realpath(workspaceRoot).catch(() => workspaceRoot);
  const realDirectory = await realpath(directory).catch(() => directory);
  if (!isInside(realDirectory, realWorkspaceRoot)) {
    throw new Error(`${description} resolves outside the workspace.`);
  }
}

async function assertOptionalDirectoryInsideWorkspace(
  workspaceRoot: string,
  directory: string,
  description: string
): Promise<void> {
  const metadata = await lstat(directory).catch(() => undefined);
  if (!metadata) {
    return;
  }
  await assertDirectoryInsideWorkspace(workspaceRoot, directory, description);
}

function isInside(target: string, root: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}
