import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

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

    const result = await execFileAsync(process.execPath, [
      "apps/cli/dist/main.js",
      "exec",
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

    expect(events.map((event) => event.type)).toEqual([
      "session.started",
      "user.input",
      "model.call.started",
      "model.call.completed",
      "model.usage",
      "tool.requested",
      "tool.risk",
      "audit.recorded",
      "file.read",
      "tool.completed",
      "model.call.started",
      "model.call.completed",
      "model.usage",
      "assistant.message",
      "session.completed"
    ]);
    expect(events.some((event) => String(event.text).includes("fixture-app"))).toBe(true);
  });

  it("exits 2 when non-interactive approval is required", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "nexus-cli-"));
    const result = await execFileWithExit(process.execPath, [
      "apps/cli/dist/main.js",
      "exec",
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
    const result = await execFileWithExit(process.execPath, [
      "apps/cli/dist/main.js",
      "exec",
      "--json",
      "--cd",
      tempDir,
      "--verify",
      "node -e \"process.exit(1)\"",
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
    const result = await execFileWithExit(process.execPath, [
      "apps/cli/dist/main.js",
      "exec",
      "--cd",
      tempDir,
      "--verify",
      "node -e \"process.exit(1)\"",
      "--rollback-on-verify-fail",
      "write hello"
    ]);

    expect(result.code).toBe(6);
    await expect(readFile(join(tempDir, "src", "hello.ts"), "utf8")).rejects.toThrow();
  });
});

async function execFileWithExit(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(command, args);
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
