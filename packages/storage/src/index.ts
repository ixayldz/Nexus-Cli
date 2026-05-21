import { lstat, mkdir, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
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
    const content = await readFile(join(runsRoot, entry.name, "manifest.json"), "utf8").catch(() => undefined);
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
  const projectStorageRoot = join(cwd, ".nexus");
  await assertSafeProjectStorageRoot(cwd, projectStorageRoot);
  const runDirectory = join(projectStorageRoot, "runs", input.sessionId);
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

  return {
    cwd,
    projectStorageRoot,
    runDirectory,
    eventLogPath,
    manifestPath,
    artifacts,
    async writeManifest(manifest: SessionManifest): Promise<void> {
      await safeWriteFile(manifestPath, `${safeJsonStringify(manifest)}\n`, runDirectory);
    },
    async readManifest(): Promise<SessionManifest> {
      return JSON.parse(await readFile(manifestPath, "utf8")) as SessionManifest;
    },
    async writeArtifact(name: keyof SessionStorage["artifacts"], content: string): Promise<void> {
      await safeWriteFile(artifacts[name], content, runDirectory);
    }
  };
}

async function safeWriteFile(filePath: string, content: string, allowedRoot: string): Promise<void> {
  await assertSafeWriteTarget(filePath, allowedRoot);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

async function assertSafeProjectStorageRoot(cwd: string, projectStorageRoot: string): Promise<void> {
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

async function assertSafeWriteTarget(filePath: string, allowedRoot: string): Promise<void> {
  const root = resolve(allowedRoot);
  const parent = dirname(resolve(filePath));
  await mkdir(parent, { recursive: true });
  const realRoot = await realpath(root).catch(() => root);
  const realParent = await realpath(parent).catch(() => parent);
  if (!isInside(realParent, realRoot)) {
    throw new Error("Artifact path resolves outside the session run directory.");
  }
}

function isInside(target: string, root: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}
