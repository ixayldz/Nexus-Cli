import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const cliPath = resolve("apps/cli/src/main.ts");
const tsxCliPath = resolve("node_modules/tsx/dist/cli.mjs");

describe("cli", () => {
  it("prints version", async () => {
    const result = await execCli(["--version"]);
    expect(result.stdout.trim()).toBe("0.1.0");
  });

  it("recognizes planned top-level commands", async () => {
    const result = await execCli(["fork"]);
    expect(result.stdout.trim()).toContain("Fork is available");
  });

  it("lists extension surfaces", async () => {
    const mcp = await execCli(["mcp"]);
    const skills = await execCli(["skills"]);
    const hooks = await execCli(["hooks"]);

    expect(mcp.stdout).toContain("No MCP servers configured");
    expect(skills.stdout).toContain("code-review");
    expect(hooks.stdout).toContain("No hooks configured");
  });

  it("allows non-interactive safe mutations after recording a plan", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nexus-cli-"));
    try {
      await writeFastMutationConfig(cwd);

      const result = await execCli(["exec", "--profile", "fake", "--cd", cwd, "write hello"]);

      expect(result.stdout).toContain("file.write:success");
      await expect(readFile(join(cwd, "src", "hello.ts"), "utf8")).resolves.toContain(
        'return "hello"'
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps high-risk non-interactive commands blocked", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nexus-cli-"));
    try {
      const failure = await execCliFailure(["exec", "--profile", "fake", "--cd", cwd, "high risk"]);

      expect(failure.code).toBe(2);
      expect(failure.stdout).toContain("shell.run:denied");
      expect(failure.stdout).toContain("Command risk is critical");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("writes requested non-interactive artifacts to guarded workspace paths", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nexus-cli-"));
    try {
      await writeFastMutationConfig(cwd);

      await execCli([
        "exec",
        "--profile",
        "fake",
        "--cd",
        cwd,
        "--output",
        "artifacts/answer.txt",
        "--patch",
        "artifacts/session.patch",
        "--report",
        "artifacts/report.json",
        "--events",
        "artifacts/events.jsonl",
        "write hello"
      ]);

      await expect(readFile(join(cwd, "artifacts", "answer.txt"), "utf8")).resolves.toContain(
        "file.write:success"
      );
      await expect(readFile(join(cwd, "artifacts", "session.patch"), "utf8")).resolves.toContain(
        "src/hello.ts"
      );
      await expect(readFile(join(cwd, "artifacts", "report.json"), "utf8")).resolves.toBe("{}\n");
      await expect(readFile(join(cwd, "artifacts", "events.jsonl"), "utf8")).resolves.toContain(
        "session.completed"
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

async function writeFastMutationConfig(cwd: string): Promise<void> {
  await mkdir(join(cwd, ".nexus"), { recursive: true });
  await writeFile(
    join(cwd, ".nexus", "config.toml"),
    [
      "[sdlc]",
      "require_verification = false",
      "require_review_for_security_sensitive_changes = false"
    ].join("\n"),
    "utf8"
  );
}

async function execCli(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(
    process.execPath,
    [tsxCliPath, "--tsconfig", "apps/cli/tsconfig.json", cliPath, ...args],
    {
      cwd: process.cwd()
    }
  );
}

async function execCliFailure(
  args: string[]
): Promise<{ code: number | undefined; stdout: string; stderr: string }> {
  try {
    await execCli(args);
    throw new Error("Expected CLI command to fail.");
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: failure.code,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? ""
    };
  }
}
