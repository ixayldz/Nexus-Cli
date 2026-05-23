import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const cliPath = resolve("apps/cli/src/main.ts");
const tsxCliPath = resolve("node_modules/tsx/dist/cli.mjs");

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("exec --json vertical slice", () => {
  it("streams valid JSONL and completes the package.json read flow", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "nexus-cli-"));
    await mkdir(join(tempDir, ".nexus"));
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({ name: "fixture-app", version: "1.2.3", scripts: { test: "vitest" } })
    );

    const result = await execCli([
      "exec",
      "--profile",
      "fake",
      "--json",
      "--cd",
      tempDir,
      "Read package.json and summarize it"
    ]);

    expect(result.stderr).toBe("");
    const events = result.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { type: string; text?: string });

    const eventTypes = events.map((event) => event.type);
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        "session.started",
        "user.input",
        "agent.step.started",
        "plan.updated",
        "tool.requested",
        "tool.completed",
        "agent.loop.completed",
        "assistant.message",
        "session.completed"
      ])
    );
    expectInOrder(eventTypes, [
      "session.started",
      "user.input",
      "tool.requested",
      "tool.completed",
      "assistant.message",
      "session.completed"
    ]);
    expect(events.some((event) => String(event.text).includes("fixture-app"))).toBe(true);
  });

  it("exits 2 when non-interactive approval is required", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "nexus-cli-"));
    const result = await execCliWithExit([
      "exec",
      "--profile",
      "fake",
      "--ask-for-approval",
      "on-request",
      "--sandbox",
      "workspace-write",
      "--json",
      "--cd",
      tempDir,
      "high risk approval demo"
    ]);

    expect(result.code).toBe(2);
    const events = result.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { type: string });
    expect(events.map((event) => event.type)).toContain("approval.required");
  });

  it("exits 6 when exec verification fails", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "nexus-cli-"));
    const result = await execCliWithExit([
      "exec",
      "--profile",
      "fake",
      "--json",
      "--cd",
      tempDir,
      "--verify",
      'node -e "process.exit(1)"',
      "hello"
    ]);

    expect(result.code).toBe(6);
    const events = result.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { type: string });
    expect(events.map((event) => event.type)).toContain("verification.completed");
  });

  it("rolls back latest checkpoint when verified exec fails", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "nexus-cli-"));
    await mkdir(join(tempDir, ".nexus"));
    await writeFile(
      join(tempDir, ".nexus", "config.toml"),
      ["[sdlc]", "require_plan_for_large_changes = false", ""].join("\n"),
      "utf8"
    );
    const result = await execCliWithExit([
      "exec",
      "--profile",
      "fake",
      "--cd",
      tempDir,
      "--verify",
      'node -e "process.exit(1)"',
      "--rollback-on-verify-fail",
      "write hello"
    ]);

    expect(result.code).toBe(6);
    await expect(readFile(join(tempDir, "src", "hello.ts"), "utf8")).rejects.toThrow();
  });
});

async function execCli(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(
    process.execPath,
    [tsxCliPath, "--tsconfig", "apps/cli/tsconfig.json", cliPath, ...args],
    {
      cwd: process.cwd()
    }
  );
}

function expectInOrder(actual: string[], expected: string[]): void {
  let cursor = -1;
  for (const type of expected) {
    const next = actual.indexOf(type, cursor + 1);
    expect(next).toBeGreaterThan(cursor);
    cursor = next;
  }
}

async function execCliWithExit(
  args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execCli(args);
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
