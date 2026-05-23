import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const cliPath = resolve("apps/cli/src/main.ts");
const tsxCliPath = resolve("node_modules/tsx/dist/cli.mjs");

describe("interactive cli", () => {
  it("starts interactive mode and handles status/quit slash commands", async () => {
    const result = await runInteractive([], "/status\n/quit\n");

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Nexus CLI interactive mode");
    expect(result.stdout).toContain("model: fake/fake-default");
    expect(result.stdout).toContain("Session closed.");
  });

  it("runs an initial prompt before composer loop", async () => {
    const result = await runInteractive(["Read package.json and summarize it"], "/quit\n");

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("[assistant]");
    expect(result.stdout).toContain("package.json");
  });

  it("approves an interactive tool request and resumes execution", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nexus-cli-"));
    try {
      const result = await runInteractive(
        ["--ask-for-approval", "always", "write hello"],
        "/approve\n/approve\n/approve\n/quit\n",
        cwd
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Approval required");
      expect(result.stdout).toContain("Approved");
      expect(result.stdout).toContain("Wrote src/hello.ts");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("handles phase 4 sdlc and memory slash commands", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nexus-cli-"));
    try {
      await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "sample" }), "utf8");
      await writeFile(join(cwd, "pnpm-lock.yaml"), "", "utf8");

      const result = await runInteractive(
        [],
        "/goal Ship Phase 4\n/plan\n/review\n/compact\n/memories accept\n/quit\n",
        cwd
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("[sdlc] Goal: Ship Phase 4");
      expect(result.stdout).toContain("Plan ready:");
      expect(result.stdout).toContain("Compacted context into");
      expect(result.stdout).toContain("Accepted");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

function runInteractive(
  args: string[],
  input: string,
  cwd = process.cwd()
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        tsxCliPath,
        "--tsconfig",
        "apps/cli/tsconfig.json",
        cliPath,
        "--profile",
        "fake",
        "--cd",
        cwd,
        ...args
      ],
      {
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      }
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Interactive process timed out. stdout=${stdout} stderr=${stderr}`));
    }, 10000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });

    child.stdin.write(input);
    child.stdin.end();
  });
}
