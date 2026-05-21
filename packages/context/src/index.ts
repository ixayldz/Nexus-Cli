import { execFile } from "node:child_process";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { type ResolvedConfig } from "@nexus/config";
import { PromptInjectionDetector, type PromptInjectionFinding } from "@nexus/security";

const execFileAsync = promisify(execFile);

export interface RepoMapFile {
  path: string;
  size: number;
}

export interface RepoMap {
  root: string;
  directories: string[];
  files: RepoMapFile[];
  truncated: boolean;
}

export interface GitContext {
  available: boolean;
  branch: string;
  status: string;
  diff: string;
}

export interface MentionResolution {
  mention: string;
  path: string;
  exists: boolean;
}

export interface MemoryInjection {
  project: string;
  user: string;
  paths: {
    project: string;
    user: string;
  };
}

export interface TokenBudgetEstimate {
  estimatedInputTokens: number;
  maxContextTokens: number;
  truncated: boolean;
}

export interface ToolOutputSummary {
  tool: string;
  status: string;
  summary: string;
}

export interface CompiledContext {
  cwd: string;
  model: string;
  modelProvider: string;
  repository: {
    repoRoot: string;
    hasPackageJson: boolean;
    packageManager: "pnpm" | "npm" | "yarn" | "unknown";
    agentsMd?: string;
    topLevelFiles: string[];
    packageScripts: Record<string, string>;
    testCommands: string[];
    repoMap: RepoMap;
    git: GitContext;
  };
  mentions: MentionResolution[];
  memories: MemoryInjection;
  toolOutputs: ToolOutputSummary[];
  tokenBudget: TokenBudgetEstimate;
  compactSummary: string;
  security: {
    promptInjectionFindings: PromptInjectionFinding[];
  };
}

export class ContextCompiler {
  public constructor(private readonly options: { userMemoryRoot?: string } = {}) {}

  public async compile(input: {
    cwd: string;
    config: ResolvedConfig;
    prompt?: string;
    toolOutputs?: ToolOutputSummary[];
  }): Promise<CompiledContext> {
    const cwd = resolve(input.cwd);
    const repoRoot = await detectRepoRoot(cwd);
    const topLevelFiles = await listTopLevelFiles(repoRoot);
    const agentsMd = await readOptionalText(join(repoRoot, "AGENTS.md"));
    const packageJson = await readPackageJson(repoRoot);
    const repoMap = await buildRepoMap(repoRoot);
    const git = await readGitContext(repoRoot);
    const memories = await readMemories(repoRoot, this.options.userMemoryRoot);
    const mentions = await resolveMentions(repoRoot, input.prompt ?? "");
    const toolOutputs = input.toolOutputs ?? [];
    const promptInjectionFindings =
      input.config.security.promptInjectionDetection && agentsMd ? new PromptInjectionDetector().detect(agentsMd) : [];
    const compactSummary = buildCompactSummary({
      cwd,
      repoRoot,
      packageManager: detectPackageManager(topLevelFiles),
      packageScripts: packageJson.scripts,
      repoMap,
      git,
      memories,
      mentions,
      toolOutputs
    });
    const tokenBudget = estimateTokenBudget({
      prompt: input.prompt ?? "",
      agentsMd: agentsMd ?? "",
      repoMap,
      git,
      memories,
      toolOutputs,
      compactSummary
    });

    return {
      cwd,
      model: input.config.model,
      modelProvider: input.config.modelProvider,
      repository: {
        repoRoot,
        hasPackageJson: topLevelFiles.includes("package.json"),
        packageManager: detectPackageManager(topLevelFiles),
        ...(agentsMd ? { agentsMd } : {}),
        topLevelFiles,
        packageScripts: packageJson.scripts,
        testCommands: detectTestCommands(detectPackageManager(topLevelFiles), packageJson.scripts),
        repoMap,
        git
      },
      mentions,
      memories,
      toolOutputs,
      tokenBudget,
      compactSummary,
      security: {
        promptInjectionFindings
      }
    };
  }
}

async function listTopLevelFiles(cwd: string): Promise<string[]> {
  try {
    const entries = await readdir(cwd, { withFileTypes: true });
    return entries.map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

async function detectRepoRoot(cwd: string): Promise<string> {
  const gitRoot = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (gitRoot.exitCode === 0 && gitRoot.stdout.trim()) {
    return resolve(gitRoot.stdout.trim());
  }

  let current = cwd;
  while (true) {
    const packageJson = await readOptionalText(join(current, "package.json"));
    if (packageJson) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return cwd;
    }
    current = parent;
  }
}

async function readOptionalText(filePath: string): Promise<string | undefined> {
  try {
    await access(filePath);
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

async function buildRepoMap(root: string): Promise<RepoMap> {
  const files: RepoMapFile[] = [];
  const directories = new Set<string>();
  const maxFiles = 200;
  const maxDepth = 4;
  await walkRepo(root, root, 0, maxDepth, maxFiles, files, directories);
  return {
    root,
    directories: [...directories].sort(),
    files,
    truncated: files.length >= maxFiles
  };
}

async function walkRepo(
  root: string,
  directory: string,
  depth: number,
  maxDepth: number,
  maxFiles: number,
  files: RepoMapFile[],
  directories: Set<string>
): Promise<void> {
  if (depth > maxDepth || files.length >= maxFiles) {
    return;
  }
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (files.length >= maxFiles || shouldSkip(entry.name)) {
      continue;
    }
    const absolutePath = join(directory, entry.name);
    const rel = normalizePath(relative(root, absolutePath));
    if (entry.isDirectory()) {
      directories.add(rel);
      await walkRepo(root, absolutePath, depth + 1, maxDepth, maxFiles, files, directories);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const metadata = await stat(absolutePath).catch(() => undefined);
    if (!metadata || metadata.size > 1024 * 1024) {
      continue;
    }
    files.push({ path: rel, size: metadata.size });
  }
}

function shouldSkip(name: string): boolean {
  return [".git", "node_modules", "dist", "build", "coverage", ".cache", ".nexus"].includes(name);
}

function detectPackageManager(files: string[]): "pnpm" | "npm" | "yarn" | "unknown" {
  if (files.includes("pnpm-lock.yaml") || files.includes("pnpm-workspace.yaml")) {
    return "pnpm";
  }
  if (files.includes("package-lock.json")) {
    return "npm";
  }
  if (files.includes("yarn.lock")) {
    return "yarn";
  }
  return "unknown";
}

async function readPackageJson(cwd: string): Promise<{ scripts: Record<string, string> }> {
  const content = await readOptionalText(join(cwd, "package.json"));
  if (!content) {
    return { scripts: {} };
  }
  try {
    const parsed = JSON.parse(content) as { scripts?: unknown };
    if (typeof parsed.scripts === "object" && parsed.scripts !== null && !Array.isArray(parsed.scripts)) {
      const scripts: Record<string, string> = {};
      for (const [name, value] of Object.entries(parsed.scripts)) {
        if (typeof value === "string") {
          scripts[name] = value;
        }
      }
      return { scripts };
    }
  } catch {
    return { scripts: {} };
  }
  return { scripts: {} };
}

function detectTestCommands(packageManager: "pnpm" | "npm" | "yarn" | "unknown", scripts: Record<string, string>): string[] {
  return ["test", "typecheck", "lint"]
    .filter((script) => Boolean(scripts[script]))
    .map((script) => packageCommand(packageManager, script));
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

async function readGitContext(cwd: string): Promise<GitContext> {
  const status = await runGit(cwd, ["status", "--short", "--branch"]);
  const diff = await runGit(cwd, ["diff", "--"]);
  return {
    available: status.exitCode === 0,
    branch: status.exitCode === 0 ? parseGitBranch(status.stdout) : "unknown",
    status: status.exitCode === 0 ? status.stdout : "",
    diff: diff.exitCode === 0 ? diff.stdout : ""
  };
}

async function runGit(cwd: string, args: string[]): Promise<{ exitCode: number; stdout: string }> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 1024 * 1024
    });
    return { exitCode: 0, stdout: result.stdout };
  } catch {
    return { exitCode: 1, stdout: "" };
  }
}

function parseGitBranch(stdout: string): string {
  const line = stdout.split(/\r?\n/).find((item) => item.startsWith("## "));
  return line?.slice(3).split("...")[0]?.trim() || "unknown";
}

async function resolveMentions(repoRoot: string, prompt: string): Promise<MentionResolution[]> {
  const matches = [...prompt.matchAll(/(?:^|\s)([A-Za-z0-9_./\\-]+\.(?:ts|tsx|js|jsx|json|md|toml|yaml|yml|css|html))/g)];
  const mentions: MentionResolution[] = [];
  for (const match of matches.slice(0, 20)) {
    const mention = match[1];
    if (!mention) {
      continue;
    }
    const absolutePath = isAbsolute(mention) ? mention : resolve(repoRoot, mention);
    const exists = await stat(absolutePath)
      .then((metadata) => metadata.isFile())
      .catch(() => false);
    mentions.push({
      mention,
      path: normalizePath(isAbsolute(mention) ? mention : relative(repoRoot, absolutePath)),
      exists
    });
  }
  return mentions;
}

async function readMemories(repoRoot: string, userMemoryRoot: string | undefined): Promise<MemoryInjection> {
  const project = join(repoRoot, ".nexus", "learning", "project-memory.md");
  const user = join(userMemoryRoot ?? join(homedir(), ".nexus", "memories"), "user-memory.md");
  return {
    project: await readOptionalText(project).then((value) => value ?? ""),
    user: await readOptionalText(user).then((value) => value ?? ""),
    paths: {
      project,
      user
    }
  };
}

function buildCompactSummary(input: {
  cwd: string;
  repoRoot: string;
  packageManager: string;
  packageScripts: Record<string, string>;
  repoMap: RepoMap;
  git: GitContext;
  memories: MemoryInjection;
  mentions: MentionResolution[];
  toolOutputs: ToolOutputSummary[];
}): string {
  const scriptNames = Object.keys(input.packageScripts);
  const changed = input.git.status
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0 && !line.startsWith("## "))
    .length;
  return [
    `cwd=${input.cwd}`,
    `repo=${basename(input.repoRoot)}`,
    `packageManager=${input.packageManager}`,
    `scripts=${scriptNames.join(",") || "none"}`,
    `filesIndexed=${input.repoMap.files.length}${input.repoMap.truncated ? "+" : ""}`,
    `gitBranch=${input.git.branch}`,
    `gitChanges=${changed}`,
    `mentions=${input.mentions.filter((mention) => mention.exists).length}`,
    `projectMemory=${input.memories.project.trim().length > 0 ? "present" : "empty"}`,
    `userMemory=${input.memories.user.trim().length > 0 ? "present" : "empty"}`,
    `toolOutputs=${input.toolOutputs.length}`
  ].join(" | ");
}

function estimateTokenBudget(input: {
  prompt: string;
  agentsMd: string;
  repoMap: RepoMap;
  git: GitContext;
  memories: MemoryInjection;
  toolOutputs: ToolOutputSummary[];
  compactSummary: string;
}): TokenBudgetEstimate {
  const chars =
    input.prompt.length +
    input.agentsMd.length +
    input.git.status.length +
    input.git.diff.length +
    input.memories.project.length +
    input.memories.user.length +
    input.compactSummary.length +
    input.repoMap.files.reduce((sum, file) => sum + file.path.length + 12, 0) +
    input.toolOutputs.reduce((sum, item) => sum + item.summary.length + item.tool.length + item.status.length, 0);
  const estimatedInputTokens = Math.ceil(chars / 4);
  const maxContextTokens = 128000;
  return {
    estimatedInputTokens,
    maxContextTokens,
    truncated: estimatedInputTokens > maxContextTokens || input.repoMap.truncated
  };
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}
