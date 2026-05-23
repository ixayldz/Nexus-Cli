import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

  it("documents fork and auth as supported commands", async () => {
    const result = await execCli(["--help"]);
    expect(result.stdout).toContain("fork                 Create a child session");
    expect(result.stdout).toContain("login/logout         Manage provider auth");
    expect(result.stdout).not.toContain("Recognized");
  });

  it("reports when fork has no parent session", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nexus-cli-"));
    try {
      const result = await execCliFailure(["fork", "--cd", cwd]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("No previous session was found to fork");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
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
      const failure = await execCliFailure([
        "exec",
        "--profile",
        "fake",
        "--ask-for-approval",
        "on-request",
        "--sandbox",
        "workspace-write",
        "--cd",
        cwd,
        "high risk"
      ]);

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

  it("forks the latest local session into a child manifest", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nexus-cli-"));
    try {
      await execCli(["exec", "--profile", "fake", "--cd", cwd, "hello"]);

      const result = await execCli(["fork", "--profile", "fake", "--cd", cwd]);

      expect(result.stdout).toContain("Forked session");
      const manifests = await readRunManifests(cwd);
      expect(manifests.some((manifest) => typeof manifest.parentSessionId === "string")).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("persists and removes provider auth records", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nexus-cli-"));
    try {
      const authPath = join(cwd, "auth.json");
      const login = await execCli([
        "login",
        "openai",
        "--api-key",
        "sk-testlogin123456",
        "--auth-file",
        authPath
      ]);

      expect(login.stdout).toContain("Stored openai auth");
      expect(login.stdout).not.toContain("sk-testlogin123456");
      await expect(readFile(authPath, "utf8").then(JSON.parse)).resolves.toMatchObject({
        providers: { openai: { apiKey: "sk-testlogin123456" } }
      });

      const logout = await execCli(["logout", "openai", "--auth-file", authPath]);

      expect(logout.stdout).toContain("Removed openai persisted auth");
      await expect(readFile(authPath, "utf8").then(JSON.parse)).resolves.toMatchObject({
        providers: {}
      });
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

async function readRunManifests(cwd: string): Promise<Array<{ parentSessionId?: string }>> {
  const runsRoot = join(cwd, ".nexus", "runs");
  const entries = await readdir(runsRoot, { withFileTypes: true });
  const manifests: Array<{ parentSessionId?: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    manifests.push(JSON.parse(await readFile(join(runsRoot, entry.name, "manifest.json"), "utf8")));
  }
  return manifests;
}
