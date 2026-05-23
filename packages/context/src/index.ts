import { execFile } from "node:child_process";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { type ResolvedConfig } from "@nexus/config";
import { PromptInjectionDetector, type PromptInjectionFinding } from "@nexus/security";
import { safeReadTextFile } from "@nexus/storage";

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
  snippet?: string;
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

export interface SessionReplaySummary {
  resumed: boolean;
  eventCount: number;
  transcript: Array<{
    role: "user" | "assistant";
    text: string;
    timestamp: string;
  }>;
  filesChanged: string[];
  commandsRun: string[];
  sdlcStages: string[];
  learningCandidateCount: number;
}

export interface SymbolIndexEntry {
  name: string;
  kind: "function" | "class" | "const" | "type" | "interface" | "export";
  path: string;
  line: number;
  exported: boolean;
}

export interface TestMapEntry {
  sourcePath: string;
  testPaths: string[];
  command?: string;
}

export interface WorkspacePackageContext {
  path: string;
  name?: string;
  scripts: Record<string, string>;
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
    workspacePackages: WorkspacePackageContext[];
    symbols: SymbolIndexEntry[];
    testMap: TestMapEntry[];
    repoMap: RepoMap;
    git: GitContext;
  };
  mentions: MentionResolution[];
  memories: MemoryInjection;
  toolOutputs: ToolOutputSummary[];
  sessionReplay?: SessionReplaySummary;
  tokenBudget: TokenBudgetEstimate;
  compactSummary: string;
  security: {
    promptInjectionFindings: PromptInjectionFinding[];
  };
}

export class ContextCompiler {
  public constructor(
    private readonly options: { userMemoryRoot?: string; sessionReplay?: SessionReplaySummary } = {}
  ) {}

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
    const packageManager = detectPackageManager(topLevelFiles);
    const workspacePackages = await buildWorkspacePackages(repoRoot, repoMap);
    const symbols = await buildSymbolIndex(repoRoot, repoMap);
    const testMap = buildTestMap(repoMap, packageManager, packageJson.scripts, workspacePackages);
    const git = await readGitContext(repoRoot);
    const memories = await readMemories(repoRoot, this.options.userMemoryRoot);
    const mentions = await resolveMentions(repoRoot, input.prompt ?? "");
    const toolOutputs = input.toolOutputs ?? [];
    const promptInjectionFindings = input.config.security.promptInjectionDetection
      ? await detectPromptInjectionSources({
          repoRoot,
          ...(agentsMd ? { agentsMd } : {}),
          repoMap,
          toolOutputs
        })
      : [];
    const compactSummary = buildCompactSummary({
      cwd,
      repoRoot,
      packageManager,
      packageScripts: packageJson.scripts,
      repoMap,
      git,
      memories,
      mentions,
      toolOutputs,
      ...(this.options.sessionReplay ? { sessionReplay: this.options.sessionReplay } : {})
    });
    const tokenBudget = estimateTokenBudget({
      prompt: input.prompt ?? "",
      agentsMd: agentsMd ?? "",
      repoMap,
      git,
      memories,
      toolOutputs,
      compactSummary,
      ...(this.options.sessionReplay ? { sessionReplay: this.options.sessionReplay } : {})
    });

    return {
      cwd,
      model: input.config.model,
      modelProvider: input.config.modelProvider,
      repository: {
        repoRoot,
        hasPackageJson: topLevelFiles.includes("package.json"),
        packageManager,
        ...(agentsMd ? { agentsMd } : {}),
        topLevelFiles,
        packageScripts: packageJson.scripts,
        testCommands: detectTestCommands(packageManager, packageJson.scripts, workspacePackages),
        workspacePackages,
        symbols,
        testMap,
        repoMap,
        git
      },
      mentions,
      memories,
      toolOutputs,
      ...(this.options.sessionReplay ? { sessionReplay: this.options.sessionReplay } : {}),
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

async function readPackageJson(
  cwd: string
): Promise<{ name?: string; scripts: Record<string, string> }> {
  const content = await readOptionalText(join(cwd, "package.json"));
  if (!content) {
    return { scripts: {} };
  }
  let parsed: { name?: unknown; scripts?: unknown };
  try {
    parsed = JSON.parse(content) as { name?: unknown; scripts?: unknown };
    if (
      typeof parsed.scripts === "object" &&
      parsed.scripts !== null &&
      !Array.isArray(parsed.scripts)
    ) {
      const scripts: Record<string, string> = {};
      for (const [name, value] of Object.entries(parsed.scripts)) {
        if (typeof value === "string") {
          scripts[name] = value;
        }
      }
      return {
        ...(typeof parsed.name === "string" ? { name: parsed.name } : {}),
        scripts
      };
    }
  } catch {
    return { scripts: {} };
  }
  return { ...(typeof parsed.name === "string" ? { name: parsed.name } : {}), scripts: {} };
}

function detectTestCommands(
  packageManager: "pnpm" | "npm" | "yarn" | "unknown",
  scripts: Record<string, string>,
  workspacePackages: WorkspacePackageContext[] = []
): string[] {
  const rootCommands = ["test", "typecheck", "lint"]
    .filter((script) => Boolean(scripts[script]))
    .map((script) => packageCommand(packageManager, script));
  const packageCommands = workspacePackages.flatMap((workspacePackage) =>
    ["test", "typecheck", "lint"]
      .filter((script) => Boolean(workspacePackage.scripts[script]))
      .map((script) =>
        packageManager === "pnpm"
          ? `pnpm --filter ${workspacePackage.name ?? workspacePackage.path} ${script}`
          : `${packageCommand(packageManager, script)} --workspace ${workspacePackage.name ?? workspacePackage.path}`
      )
  );
  return [...new Set([...rootCommands, ...packageCommands])].slice(0, 20);
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

async function buildWorkspacePackages(
  repoRoot: string,
  repoMap: RepoMap
): Promise<WorkspacePackageContext[]> {
  const packageFiles = repoMap.files
    .map((file) => file.path)
    .filter((path) => path.endsWith("package.json") && path !== "package.json")
    .slice(0, 50);
  const packages: WorkspacePackageContext[] = [];
  for (const path of packageFiles) {
    const packageJson = await readPackageJson(join(repoRoot, dirname(path)));
    if (Object.keys(packageJson.scripts).length === 0 && !packageJson.name) {
      continue;
    }
    packages.push({
      path: normalizePath(dirname(path)),
      ...(packageJson.name ? { name: packageJson.name } : {}),
      scripts: packageJson.scripts
    });
  }
  return packages;
}

async function buildSymbolIndex(repoRoot: string, repoMap: RepoMap): Promise<SymbolIndexEntry[]> {
  const files = repoMap.files
    .map((file) => file.path)
    .filter(isSourceFile)
    .slice(0, 80);
  const symbols: SymbolIndexEntry[] = [];
  for (const file of files) {
    const content = await readOptionalText(join(repoRoot, file));
    if (!content) {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const parsed = parseSymbolLine(line);
      if (!parsed) {
        continue;
      }
      symbols.push({
        ...parsed,
        path: file,
        line: index + 1
      });
      if (symbols.length >= 500) {
        return symbols;
      }
    }
  }
  return symbols;
}

function buildTestMap(
  repoMap: RepoMap,
  packageManager: "pnpm" | "npm" | "yarn" | "unknown",
  packageScripts: Record<string, string>,
  workspacePackages: WorkspacePackageContext[]
): TestMapEntry[] {
  const repoFiles = repoMap.files.map((file) => normalizePath(file.path));
  const fileSet = new Set(repoFiles);
  const defaultCommand = detectTestCommands(packageManager, packageScripts, workspacePackages)[0];
  return repoFiles
    .filter(isSourceFile)
    .slice(0, 200)
    .map((sourcePath) => ({
      sourcePath,
      testPaths: findLikelyTestsForSource(sourcePath, fileSet),
      ...(defaultCommand ? { command: defaultCommand } : {})
    }))
    .filter((entry) => entry.testPaths.length > 0 || entry.command);
}

function parseSymbolLine(line: string): Omit<SymbolIndexEntry, "path" | "line"> | undefined {
  const match =
    /^\s*(export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(line) ??
    /^\s*(export\s+)?class\s+([A-Za-z_$][\w$]*)/.exec(line) ??
    /^\s*(export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(line) ??
    /^\s*(export\s+)?interface\s+([A-Za-z_$][\w$]*)/.exec(line) ??
    /^\s*(export\s+)?type\s+([A-Za-z_$][\w$]*)/.exec(line) ??
    /^\s*export\s+\{\s*([^}]+)\s*\}/.exec(line);
  if (!match?.[2] && !match?.[1]) {
    return undefined;
  }
  if (line.trim().startsWith("export {")) {
    const name = (match[1] ?? "")
      .split(",")[0]
      ?.trim()
      .split(/\s+as\s+/i)[0]
      ?.trim();
    return name ? { name, kind: "export", exported: true } : undefined;
  }
  const kind = line.includes("function ")
    ? "function"
    : line.includes("class ")
      ? "class"
      : line.includes("interface ")
        ? "interface"
        : line.includes("type ")
          ? "type"
          : "const";
  return {
    name: match[2] ?? "",
    kind,
    exported: Boolean(match[1])
  };
}

function findLikelyTestsForSource(sourcePath: string, fileSet: Set<string>): string[] {
  const directory = dirname(sourcePath).replaceAll("\\", "/");
  const stem = basename(sourcePath).replace(/\.(?:ts|tsx|js|jsx|mjs|cjs)$/, "");
  const extensions = [".test.ts", ".spec.ts", ".test.tsx", ".spec.tsx", ".test.js", ".spec.js"];
  return extensions
    .flatMap((extension) => [
      `${directory}/${stem}${extension}`.replace(/^\.\//, ""),
      `${directory}/__tests__/${stem}${extension}`.replace(/^\.\//, "")
    ])
    .filter(
      (candidate, index, candidates) =>
        fileSet.has(candidate) && candidates.indexOf(candidate) === index
    )
    .slice(0, 5);
}

function isSourceFile(path: string): boolean {
  return /\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(path) && !/\.d\.ts$/.test(path) && !isTestFile(path);
}

function isTestFile(path: string): boolean {
  return /(?:^|[/\\])__tests__[/\\]|\.test\.(?:ts|tsx|js|jsx|mjs|cjs)$|\.spec\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(
    path
  );
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
  const matches = [
    ...prompt.matchAll(
      /(?:^|\s)([A-Za-z0-9_./\\-]+\.(?:ts|tsx|js|jsx|json|md|toml|yaml|yml|css|html))/g
    )
  ];
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
    const snippet = exists
      ? await readOptionalText(absolutePath).then((content) => content?.slice(0, 4000))
      : undefined;
    mentions.push({
      mention,
      path: normalizePath(isAbsolute(mention) ? mention : relative(repoRoot, absolutePath)),
      exists,
      ...(snippet ? { snippet } : {})
    });
  }
  return mentions;
}

async function readMemories(
  repoRoot: string,
  userMemoryRoot: string | undefined
): Promise<MemoryInjection> {
  const project = join(repoRoot, ".nexus", "learning", "project-memory.md");
  const userRoot = userMemoryRoot ?? join(homedir(), ".nexus", "memories");
  const user = join(userRoot, "user-memory.md");
  return {
    project:
      (await safeReadTextFile({
        path: project,
        allowedRoot: join(repoRoot, ".nexus"),
        workspaceRoot: repoRoot,
        rootDescription: ".nexus learning storage"
      })) ?? "",
    user:
      (await safeReadTextFile({
        path: user,
        allowedRoot: userRoot,
        workspaceRoot: userRoot,
        rootDescription: "user memory storage"
      })) ?? "",
    paths: {
      project,
      user
    }
  };
}

async function detectPromptInjectionSources(input: {
  repoRoot: string;
  agentsMd?: string;
  repoMap: RepoMap;
  toolOutputs: ToolOutputSummary[];
}): Promise<PromptInjectionFinding[]> {
  const detector = new PromptInjectionDetector();
  const findings: PromptInjectionFinding[] = [];
  const seenSources = new Set<string>();

  const scan = (source: string, content: string | undefined): void => {
    if (!content?.trim() || seenSources.has(source)) {
      return;
    }
    seenSources.add(source);
    findings.push(...detector.detect(content.slice(0, 20000), source));
  };

  scan("file:AGENTS.md", input.agentsMd);

  for (const file of promptInjectionRepoFiles(input.repoMap)) {
    scan(`file:${file.path}`, await readOptionalText(join(input.repoRoot, file.path)));
  }

  scan(
    "mcp:registry",
    await safeReadTextFile({
      path: join(input.repoRoot, ".nexus", "mcp.json"),
      allowedRoot: join(input.repoRoot, ".nexus"),
      workspaceRoot: input.repoRoot,
      rootDescription: ".nexus MCP registry"
    })
  );

  for (const output of input.toolOutputs) {
    scan(`tool:${output.tool}`, `${output.status}\n${output.summary}`);
  }

  return dedupePromptInjectionFindings(findings);
}

function promptInjectionRepoFiles(repoMap: RepoMap): RepoMapFile[] {
  return repoMap.files
    .filter((file) => {
      const name = basename(file.path).toLowerCase();
      return (
        name === "readme.md" ||
        name === "readme" ||
        name === "contributing.md" ||
        name === "security.md" ||
        name === "mcp.md" ||
        file.path.toLowerCase().startsWith("docs/")
      );
    })
    .slice(0, 40);
}

function dedupePromptInjectionFindings(
  findings: PromptInjectionFinding[]
): PromptInjectionFinding[] {
  const seen = new Set<string>();
  const deduped: PromptInjectionFinding[] = [];
  for (const finding of findings) {
    const key = `${finding.source ?? ""}|${finding.phrase}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(finding);
  }
  return deduped;
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
  sessionReplay?: SessionReplaySummary;
}): string {
  const scriptNames = Object.keys(input.packageScripts);
  const changed = input.git.status
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0 && !line.startsWith("## ")).length;
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
    `toolOutputs=${input.toolOutputs.length}`,
    `replayEvents=${input.sessionReplay?.eventCount ?? 0}`
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
  sessionReplay?: SessionReplaySummary;
}): TokenBudgetEstimate {
  const chars =
    input.prompt.length +
    input.agentsMd.length +
    input.git.status.length +
    input.git.diff.length +
    input.memories.project.length +
    input.memories.user.length +
    input.compactSummary.length +
    (input.sessionReplay?.transcript.reduce((sum, item) => sum + item.text.length, 0) ?? 0) +
    input.repoMap.files.reduce((sum, file) => sum + file.path.length + 12, 0) +
    input.toolOutputs.reduce(
      (sum, item) => sum + item.summary.length + item.tool.length + item.status.length,
      0
    );
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
