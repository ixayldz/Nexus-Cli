#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { defaultConfig } from "@nexus/config";
import { ContextCompiler } from "@nexus/context";
import { McpRegistry } from "@nexus/mcp";
import { redactString, safeJsonStringify } from "@nexus/shared";
import { safeAtomicWriteText } from "@nexus/storage";

const execFileAsync = promisify(execFile);

export interface DogfoodScenarioResult {
  name: string;
  status: "passed" | "failed";
  summary: string;
  details: string[];
}

export interface DogfoodReport {
  status: "passed" | "failed";
  live: boolean;
  results: DogfoodScenarioResult[];
  createdAt: string;
}

export interface DogfoodEvalInput {
  cwd: string;
  live?: boolean;
  writeReport?: boolean;
}

export async function runDogfoodEval(input: DogfoodEvalInput): Promise<DogfoodReport> {
  const results = [
    await runReadOnlyCliScenario(input.cwd),
    await runExplicitMutationScenario(input.cwd),
    await runRollbackScenario(input.cwd),
    await runContextSymlinkScenario(),
    await runMcpSymlinkScenario(),
    await runNoSecretOutputScenario(input.cwd),
    ...(input.live === true
      ? [await runDeepSeekLiveScenario(input.cwd), await runGithubAuthScenario()]
      : [])
  ];
  const report: DogfoodReport = {
    status: results.every((result) => result.status === "passed") ? "passed" : "failed",
    live: input.live === true,
    results,
    createdAt: new Date().toISOString()
  };
  if (input.writeReport) {
    await safeAtomicWriteText({
      path: join(input.cwd, ".nexus", "evals", "dogfood-report.json"),
      allowedRoot: join(input.cwd, ".nexus"),
      workspaceRoot: input.cwd,
      content: `${safeJsonStringify(report)}\n`,
      rootDescription: ".nexus dogfood eval storage"
    });
  }
  return report;
}

async function runReadOnlyCliScenario(cwd: string): Promise<DogfoodScenarioResult> {
  const fixture = await createFixtureRepo();
  try {
    const result = await execCli(cwd, [
      "exec",
      "--profile",
      "fake",
      "--json",
      "--cd",
      fixture,
      "Read package.json and summarize it"
    ]);
    const events = parseJsonlEvents(result.stdout);
    const eventTypes = events.map((event) => String(event.type));
    return scenarioResult(
      "read-only exec JSONL",
      result.code === 0 &&
        eventTypes.includes("tool.completed") &&
        eventTypes.includes("session.completed") &&
        result.stdout.includes("fixture-app"),
      [`exit=${result.code}`, `events=${eventTypes.join(",")}`]
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

async function runExplicitMutationScenario(cwd: string): Promise<DogfoodScenarioResult> {
  const fixture = await createFixtureRepo();
  try {
    const result = await execCli(cwd, [
      "exec",
      "--profile",
      "fake",
      "--allow-mutations",
      "--cd",
      fixture,
      "write hello"
    ]);
    const content = await readFile(join(fixture, "src", "hello.ts"), "utf8").catch(() => "");
    return scenarioResult("explicit mutation", content.includes("hello"), [`exit=${result.code}`]);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

async function runRollbackScenario(cwd: string): Promise<DogfoodScenarioResult> {
  const fixture = await createFixtureRepo();
  try {
    await writeFile(
      join(fixture, ".nexus", "config.toml"),
      ["[sdlc]", "require_plan_for_large_changes = false", ""].join("\n"),
      "utf8"
    );
    const result = await execCli(cwd, [
      "exec",
      "--profile",
      "fake",
      "--cd",
      fixture,
      "--verify",
      'node -e "process.exit(1)"',
      "--rollback-on-verify-fail",
      "write hello"
    ]);
    const restored = !(await readFile(join(fixture, "src", "hello.ts"), "utf8").catch(
      () => undefined
    ));
    return scenarioResult("rollback on verify fail", result.code === 6 && restored, [
      `exit=${result.code}`,
      `restored=${restored}`
    ]);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

async function runContextSymlinkScenario(): Promise<DogfoodScenarioResult> {
  const fixture = await mkdtemp(join(tmpdir(), "nexus-dogfood-context-"));
  const external = await mkdtemp(join(tmpdir(), "nexus-dogfood-context-external-"));
  try {
    await mkdir(join(fixture, ".nexus", "learning"), { recursive: true });
    await writeFile(join(external, "project-memory.md"), "# External\n", "utf8");
    try {
      await symlink(
        join(external, "project-memory.md"),
        join(fixture, ".nexus", "learning", "project-memory.md"),
        "file"
      );
    } catch {
      return scenarioResult("context symlink refusal", true, ["symlink unsupported"]);
    }
    await new ContextCompiler().compile({
      cwd: fixture,
      config: { ...defaultConfig, sources: [] }
    });
    return scenarioResult("context symlink refusal", false, ["compile unexpectedly passed"]);
  } catch (error) {
    return scenarioResult("context symlink refusal", message(error).includes("symlink"), [
      message(error)
    ]);
  } finally {
    await rm(fixture, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
}

async function runMcpSymlinkScenario(): Promise<DogfoodScenarioResult> {
  const fixture = await mkdtemp(join(tmpdir(), "nexus-dogfood-mcp-"));
  const external = await mkdtemp(join(tmpdir(), "nexus-dogfood-mcp-external-"));
  try {
    await mkdir(join(fixture, ".nexus"), { recursive: true });
    await writeFile(join(external, "mcp.json"), "{}", "utf8");
    try {
      await symlink(join(external, "mcp.json"), join(fixture, ".nexus", "mcp.json"), "file");
    } catch {
      return scenarioResult("MCP registry symlink refusal", true, ["symlink unsupported"]);
    }
    await new McpRegistry().list(fixture);
    return scenarioResult("MCP registry symlink refusal", false, [
      "registry read unexpectedly passed"
    ]);
  } catch (error) {
    return scenarioResult("MCP registry symlink refusal", message(error).includes("symlink"), [
      message(error)
    ]);
  } finally {
    await rm(fixture, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
}

async function runNoSecretOutputScenario(cwd: string): Promise<DogfoodScenarioResult> {
  const fixture = await createFixtureRepo();
  try {
    const result = await execCli(cwd, [
      "exec",
      "--profile",
      "fake",
      "--json",
      "--cd",
      fixture,
      "Read package.json and summarize it"
    ]);
    const redacted = redactString(result.stdout);
    return scenarioResult("no unredacted secret in JSONL", result.stdout === redacted, [
      `exit=${result.code}`
    ]);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

async function runDeepSeekLiveScenario(cwd: string): Promise<DogfoodScenarioResult> {
  const result = await execTsx(cwd, [
    resolve(cwd, "packages", "evals", "src", "provider-smoke.ts"),
    "--provider",
    "deepseek",
    "--require-live"
  ]);
  return scenarioResult("DeepSeek live provider smoke", result.code === 0, [
    `exit=${result.code}`,
    result.stdout.trim() || result.stderr.trim()
  ]);
}

async function runGithubAuthScenario(): Promise<DogfoodScenarioResult> {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) {
    return scenarioResult("GitHub token auth", false, ["GITHUB_TOKEN/GH_TOKEN is not set"]);
  }
  try {
    const response = await fetch("https://api.github.com/user", {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "user-agent": "nexus-cli-dogfood"
      }
    });
    return scenarioResult("GitHub token auth", response.status === 200, [
      `status=${response.status}`
    ]);
  } catch (error) {
    return scenarioResult("GitHub token auth", false, [message(error)]);
  }
}

async function createFixtureRepo(): Promise<string> {
  const fixture = await mkdtemp(join(tmpdir(), "nexus-dogfood-"));
  await mkdir(join(fixture, ".nexus"), { recursive: true });
  await writeFile(
    join(fixture, "package.json"),
    JSON.stringify({ name: "fixture-app", version: "1.0.0", scripts: { test: "node --version" } }),
    "utf8"
  );
  return fixture;
}

async function execCli(
  cwd: string,
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  return execTsx(cwd, [
    "--tsconfig",
    "apps/cli/tsconfig.json",
    resolve(cwd, "apps", "cli", "src", "main.ts"),
    ...args
  ]);
}

async function execTsx(
  cwd: string,
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(
      process.execPath,
      [resolve(cwd, "node_modules", "tsx", "dist", "cli.mjs"), ...args],
      {
        cwd,
        timeout: 120_000,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024
      }
    );
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const execError = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: execError.code ?? 1,
      stdout: execError.stdout ?? "",
      stderr: execError.stderr ?? ""
    };
  }
}

function parseJsonlEvents(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .trim()
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function scenarioResult(name: string, passed: boolean, details: string[]): DogfoodScenarioResult {
  return {
    name,
    status: passed ? "passed" : "failed",
    summary: passed ? "ok" : "failed",
    details: details.map((item) => redactString(item).slice(0, 500))
  };
}

function message(error: unknown): string {
  return redactString(error instanceof Error ? error.message : String(error));
}

async function main(): Promise<void> {
  const live = process.argv.includes("--live");
  const report = await runDogfoodEval({ cwd: process.cwd(), live, writeReport: true });
  for (const result of report.results) {
    process.stdout.write(`${result.status}: ${result.name} - ${result.summary}\n`);
  }
  process.stdout.write(`${report.status}: ${report.results.length} dogfood scenario(s)\n`);
  if (report.status === "failed") {
    process.exitCode = 1;
  }
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  await main();
}
