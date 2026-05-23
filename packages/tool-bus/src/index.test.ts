import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "@nexus/config";
import { InMemoryEventBus } from "@nexus/events";
import { ApprovalCoordinator, SecurityRuntime } from "@nexus/security";
import { SandboxManager, TypescriptSandboxAdapter } from "@nexus/sandbox";
import { type SessionId } from "@nexus/shared";
import { RollbackManager, createDefaultToolBus, createToolRequest } from "./index.js";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("tool bus runtime MVP tools", () => {
  it("writes files with checkpoint metadata", async () => {
    const ctx = await makeContext();
    const result = await createDefaultToolBus().execute(
      createToolRequest({
        toolName: "file.write",
        input: { path: "src/index.ts", content: "export const value = 1;\n", createDirs: true },
        source: "user"
      }),
      ctx
    );

    expect(result.status).toBe("success");
    expect(result.filesChanged).toEqual(["src/index.ts"]);
    await expect(readFile(join(ctx.cwd, "src", "index.ts"), "utf8")).resolves.toBe(
      "export const value = 1;\n"
    );
  });

  it("rolls back the latest file checkpoint", async () => {
    const ctx = await makeContext();
    await writeFile(join(ctx.cwd, "hello.txt"), "old\n", "utf8");
    await createDefaultToolBus().execute(
      createToolRequest({
        toolName: "file.write",
        input: { path: "hello.txt", content: "new\n" },
        source: "user"
      }),
      ctx
    );

    const rollback = await new RollbackManager().rollback({ checkpointId: "latest", ctx });

    expect(rollback.status).toBe("restored");
    await expect(readFile(join(ctx.cwd, "hello.txt"), "utf8")).resolves.toBe("old\n");
  });

  it("returns not_found for missing rollback checkpoints", async () => {
    const ctx = await makeContext();
    const rollback = await new RollbackManager().rollback({ checkpointId: "missing", ctx });

    expect(rollback.status).toBe("not_found");
  });

  it("refuses rollback targets denied by path policy", async () => {
    const ctx = await makeContext();
    const checkpointDirectory = join(ctx.runDirectory, "checkpoints");
    await mkdir(checkpointDirectory, { recursive: true });
    await writeFile(
      join(checkpointDirectory, "checkpoint_env.json"),
      JSON.stringify({
        id: "checkpoint_env",
        sessionId: ctx.sessionId,
        filePath: ".env",
        absolutePath: join(ctx.cwd, ".env"),
        beforeHash: null,
        beforeContent: "OPENAI_API_KEY=sk-secret123456",
        createdAt: "2026-05-20T00:00:00.000Z"
      }),
      "utf8"
    );

    const rollback = await new RollbackManager().rollback({ checkpointId: "checkpoint_env", ctx });

    expect(rollback.status).toBe("refused");
    expect(rollback.refusedReason).toContain("protected");
  });

  it("refuses transaction rollback before restoring any child when a target is denied", async () => {
    const ctx = await makeContext();
    const checkpointDirectory = join(ctx.runDirectory, "checkpoints");
    await mkdir(checkpointDirectory, { recursive: true });
    await writeFile(join(ctx.cwd, "safe.txt"), "mutated\n", "utf8");
    await writeFile(
      join(checkpointDirectory, "checkpoint_safe.json"),
      JSON.stringify({
        id: "checkpoint_safe",
        sessionId: ctx.sessionId,
        filePath: "safe.txt",
        absolutePath: join(ctx.cwd, "safe.txt"),
        beforeHash: null,
        beforeContent: "original\n",
        createdAt: "2026-05-20T00:00:00.000Z"
      }),
      "utf8"
    );
    await writeFile(
      join(checkpointDirectory, "checkpoint_env.json"),
      JSON.stringify({
        id: "checkpoint_env",
        sessionId: ctx.sessionId,
        filePath: ".env",
        absolutePath: join(ctx.cwd, ".env"),
        beforeHash: null,
        beforeContent: "OPENAI_API_KEY=sk-secret123456",
        createdAt: "2026-05-20T00:00:01.000Z"
      }),
      "utf8"
    );
    await writeFile(
      join(checkpointDirectory, "checkpoint_transaction.json"),
      JSON.stringify({
        id: "checkpoint_transaction",
        type: "transaction",
        sessionId: ctx.sessionId,
        childCheckpointIds: ["checkpoint_safe", "checkpoint_env"],
        createdAt: "2026-05-20T00:00:02.000Z"
      }),
      "utf8"
    );

    const rollback = await new RollbackManager().rollback({
      checkpointId: "checkpoint_transaction",
      ctx
    });

    expect(rollback.status).toBe("refused");
    expect(rollback.refusedReason).toContain("protected");
    await expect(readFile(join(ctx.cwd, "safe.txt"), "utf8")).resolves.toBe("mutated\n");
  });

  it("selects transaction checkpoints before child checkpoints when latest timestamps tie", async () => {
    const ctx = await makeContext();
    const checkpointDirectory = join(ctx.runDirectory, "checkpoints");
    await mkdir(checkpointDirectory, { recursive: true });
    await writeFile(join(ctx.cwd, "old-name.txt"), "missing after rename\n", "utf8");
    await writeFile(join(ctx.cwd, "new-name.txt"), "rename me\n", "utf8");
    const createdAt = "2026-05-20T00:00:00.000Z";
    await writeFile(
      join(checkpointDirectory, "checkpoint_source.json"),
      JSON.stringify({
        id: "checkpoint_source",
        sessionId: ctx.sessionId,
        filePath: "old-name.txt",
        absolutePath: join(ctx.cwd, "old-name.txt"),
        beforeHash: null,
        beforeContent: "rename me\n",
        createdAt
      }),
      "utf8"
    );
    await writeFile(
      join(checkpointDirectory, "checkpoint_target.json"),
      JSON.stringify({
        id: "checkpoint_target",
        sessionId: ctx.sessionId,
        filePath: "new-name.txt",
        absolutePath: join(ctx.cwd, "new-name.txt"),
        beforeHash: null,
        beforeContent: null,
        createdAt
      }),
      "utf8"
    );
    await writeFile(
      join(checkpointDirectory, "checkpoint_transaction.json"),
      JSON.stringify({
        id: "checkpoint_transaction",
        type: "transaction",
        sessionId: ctx.sessionId,
        childCheckpointIds: ["checkpoint_source", "checkpoint_target"],
        createdAt
      }),
      "utf8"
    );

    const rollback = await new RollbackManager().rollback({ checkpointId: "latest", ctx });

    expect(rollback.status).toBe("restored");
    expect(rollback.checkpointId).toBe("checkpoint_transaction");
    await expect(readFile(join(ctx.cwd, "old-name.txt"), "utf8")).resolves.toBe("rename me\n");
    await expect(readFile(join(ctx.cwd, "new-name.txt"), "utf8")).rejects.toThrow();
  });

  it("applies a simple unified patch", async () => {
    const ctx = await makeContext();
    await writeFile(join(ctx.cwd, "hello.txt"), "old\n", "utf8");
    const diffs: string[] = [];
    ctx.eventBus.subscribe((event) => {
      if (event.type === "file.changed" && typeof event.diff === "string") {
        diffs.push(event.diff);
      }
    });

    const result = await createDefaultToolBus().execute(
      createToolRequest({
        toolName: "patch.apply",
        input: {
          patch: ["--- a/hello.txt", "+++ b/hello.txt", "@@ -1,1 +1,1 @@", "-old", "+new"].join(
            "\n"
          )
        },
        source: "user"
      }),
      ctx
    );

    expect(result.status).toBe("success");
    expect(JSON.stringify(result.output)).toContain("hello.txt");
    expect(diffs.join("\n")).toContain("hello.txt");
    await expect(readFile(join(ctx.cwd, "hello.txt"), "utf8")).resolves.toBe("new\n");
  });

  it("applies new file, delete file, and rename patches", async () => {
    const ctx = await makeContext();
    await writeFile(join(ctx.cwd, "remove.txt"), "remove me\n", "utf8");
    await writeFile(join(ctx.cwd, "old-name.txt"), "rename me\n", "utf8");

    const result = await createDefaultToolBus().execute(
      createToolRequest({
        toolName: "patch.apply",
        input: {
          patch: [
            "diff --git a/new.txt b/new.txt",
            "new file mode 100644",
            "--- /dev/null",
            "+++ b/new.txt",
            "@@ -0,0 +1,1 @@",
            "+created",
            "diff --git a/remove.txt b/remove.txt",
            "deleted file mode 100644",
            "--- a/remove.txt",
            "+++ /dev/null",
            "@@ -1,1 +0,0 @@",
            "-remove me",
            "diff --git a/old-name.txt b/new-name.txt",
            "similarity index 100%",
            "rename from old-name.txt",
            "rename to new-name.txt"
          ].join("\n")
        },
        source: "user"
      }),
      ctx
    );

    expect(result.status).toBe("success");
    expect(result.filesChanged).toEqual(
      expect.arrayContaining(["new.txt", "remove.txt", "old-name.txt", "new-name.txt"])
    );
    expect(JSON.stringify(result.output)).toContain("createdFiles");
    expect(JSON.stringify(result.output)).toContain("deletedFiles");
    expect(JSON.stringify(result.output)).toContain("renamedFiles");
    await expect(readFile(join(ctx.cwd, "new.txt"), "utf8")).resolves.toBe("created\n");
    await expect(readFile(join(ctx.cwd, "remove.txt"), "utf8")).rejects.toThrow();
    await expect(readFile(join(ctx.cwd, "new-name.txt"), "utf8")).resolves.toBe("rename me\n");
  });

  it("rolls back rename patches as one transaction", async () => {
    const ctx = await makeContext();
    await writeFile(join(ctx.cwd, "old-name.txt"), "rename me\n", "utf8");

    const result = await createDefaultToolBus().execute(
      createToolRequest({
        toolName: "patch.apply",
        input: {
          patch: [
            "diff --git a/old-name.txt b/new-name.txt",
            "similarity index 100%",
            "rename from old-name.txt",
            "rename to new-name.txt"
          ].join("\n")
        },
        source: "user"
      }),
      ctx
    );
    const output = result.output as { checkpoints: string[] };

    expect(result.status).toBe("success");
    expect(output.checkpoints).toHaveLength(1);
    await expect(readFile(join(ctx.cwd, "new-name.txt"), "utf8")).resolves.toBe("rename me\n");

    const rollback = await new RollbackManager().rollback({ checkpointId: "latest", ctx });

    expect(rollback.status).toBe("restored");
    expect(rollback.checkpointId).toBe(output.checkpoints[0]);
    await expect(readFile(join(ctx.cwd, "old-name.txt"), "utf8")).resolves.toBe("rename me\n");
    await expect(readFile(join(ctx.cwd, "new-name.txt"), "utf8")).rejects.toThrow();
  });

  it("rolls back multi-file patches as one transaction", async () => {
    const ctx = await makeContext();
    await writeFile(join(ctx.cwd, "modify.txt"), "old\n", "utf8");
    await writeFile(join(ctx.cwd, "remove.txt"), "remove me\n", "utf8");

    const result = await createDefaultToolBus().execute(
      createToolRequest({
        toolName: "patch.apply",
        input: {
          patch: [
            "diff --git a/new.txt b/new.txt",
            "new file mode 100644",
            "--- /dev/null",
            "+++ b/new.txt",
            "@@ -0,0 +1,1 @@",
            "+created",
            "diff --git a/modify.txt b/modify.txt",
            "--- a/modify.txt",
            "+++ b/modify.txt",
            "@@ -1,1 +1,1 @@",
            "-old",
            "+new",
            "diff --git a/remove.txt b/remove.txt",
            "deleted file mode 100644",
            "--- a/remove.txt",
            "+++ /dev/null",
            "@@ -1,1 +0,0 @@",
            "-remove me"
          ].join("\n")
        },
        source: "user"
      }),
      ctx
    );
    const output = result.output as { checkpoints: string[] };

    expect(result.status).toBe("success");
    expect(output.checkpoints).toHaveLength(1);

    const rollback = await new RollbackManager().rollback({
      checkpointId: output.checkpoints[0]!,
      ctx
    });

    expect(rollback.status).toBe("restored");
    await expect(readFile(join(ctx.cwd, "new.txt"), "utf8")).rejects.toThrow();
    await expect(readFile(join(ctx.cwd, "modify.txt"), "utf8")).resolves.toBe("old\n");
    await expect(readFile(join(ctx.cwd, "remove.txt"), "utf8")).resolves.toBe("remove me\n");
  });

  it("rejects binary patches with a safe failure", async () => {
    const ctx = await makeContext();
    const result = await createDefaultToolBus().execute(
      createToolRequest({
        toolName: "patch.apply",
        input: {
          patch: [
            "diff --git a/image.png b/image.png",
            "--- a/image.png",
            "+++ b/image.png",
            "Binary files differ"
          ].join("\n")
        },
        source: "user"
      }),
      ctx
    );

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("Binary patches are not supported");
  });

  it("rejects patches whose context does not match the target file", async () => {
    const ctx = await makeContext();
    await writeFile(join(ctx.cwd, "hello.txt"), "current\n", "utf8");

    const result = await createDefaultToolBus().execute(
      createToolRequest({
        toolName: "patch.apply",
        input: {
          patch: ["--- a/hello.txt", "+++ b/hello.txt", "@@ -1,1 +1,1 @@", "-old", "+new"].join(
            "\n"
          )
        },
        source: "user"
      }),
      ctx
    );

    expect(result.status).toBe("failed");
    expect(result.summary).toContain("Patch context mismatch");
  });

  it("redacts secret-like values from file diffs", async () => {
    const ctx = await makeContext();
    const result = await createDefaultToolBus().execute(
      createToolRequest({
        toolName: "file.write",
        input: { path: "secret.txt", content: "token=Bearer abcdefghijklmnopqrstuvwxyz" },
        source: "user"
      }),
      ctx
    );

    expect(JSON.stringify(result.output)).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(JSON.stringify(result.output)).toContain("[REDACTED]");
  });

  it("denies shell execution when hard sandbox is unavailable", async () => {
    const ctx = await makeContext();
    const result = await createDefaultToolBus().execute(
      createToolRequest({
        toolName: "shell.run",
        input: { command: "node --version" },
        source: "user"
      }),
      { ...ctx, sandbox: new SandboxManager([new TypescriptSandboxAdapter()]) }
    );

    expect(result.status).toBe("denied");
    expect(result.exitCodeHint).toBe(3);
    expect(result.summary).toContain("hard sandbox");
    expect(result.commandsRun).toEqual([]);
  });

  it("denies test execution when hard sandbox is unavailable", async () => {
    const ctx = await makeContext();
    const result = await createDefaultToolBus().execute(
      createToolRequest({
        toolName: "test.run",
        input: { command: "node --version" },
        source: "user"
      }),
      { ...ctx, sandbox: new SandboxManager([new TypescriptSandboxAdapter()]) }
    );

    expect(result.status).toBe("denied");
    expect(result.exitCodeHint).toBe(3);
  });

  it("requires approval for high-risk shell in non-interactive mode", async () => {
    const ctx = await makeContext();
    const result = await createDefaultToolBus().execute(
      createToolRequest({
        toolName: "shell.run",
        input: { command: "rm -rf ." },
        source: "model"
      }),
      ctx
    );

    expect(result.status).toBe("denied");
    expect(result.exitCodeHint).toBe(2);
  });

  it("resumes an interactive tool call after approval is granted", async () => {
    const ctx = await makeContext();
    const approvals = new ApprovalCoordinator();
    const execution = createDefaultToolBus().execute(
      createToolRequest({
        toolName: "file.write",
        input: { path: "approved.txt", content: "approved\n" },
        source: "user"
      }),
      {
        ...ctx,
        approvals,
        nonInteractive: false,
        config: { ...ctx.config, approvalPolicy: "always" }
      }
    );

    const request = await waitForApproval(approvals, ctx.sessionId);
    expect(request?.toolName).toBe("file.write");
    if (!request) {
      throw new Error("Expected a pending approval request.");
    }
    approvals.decide(request.id, "approved");

    await expect(execution).resolves.toMatchObject({ status: "success" });
    await expect(readFile(join(ctx.cwd, "approved.txt"), "utf8")).resolves.toBe("approved\n");
  });

  it("fails closed when hard sandbox is required but unavailable", async () => {
    const ctx = await makeContext();
    const result = await createDefaultToolBus().execute(
      createToolRequest({
        toolName: "shell.run",
        input: { command: "node --version" },
        source: "user"
      }),
      {
        ...ctx,
        sandbox: new SandboxManager([new TypescriptSandboxAdapter()]),
        config: { ...ctx.config, security: { ...ctx.config.security, requireHardSandbox: true } }
      }
    );

    expect(result.status).toBe("denied");
    expect(result.exitCodeHint).toBe(3);
  });

  it("denies network shell commands when network policy is off", async () => {
    const ctx = await makeContext();
    const result = await createDefaultToolBus().execute(
      createToolRequest({
        toolName: "shell.run",
        input: { command: "curl https://example.test" },
        source: "user"
      }),
      ctx
    );

    expect(result.status).toBe("denied");
    expect(result.summary).toContain("Network access is disabled");
  });

  it("denies protected path writes when approval is disabled", async () => {
    const ctx = await makeContext();
    const result = await createDefaultToolBus().execute(
      createToolRequest({
        toolName: "file.write",
        input: { path: ".env", content: "OPENAI_API_KEY=sk-secret123456" },
        source: "model"
      }),
      {
        ...ctx,
        config: { ...ctx.config, approvalPolicy: "never" }
      }
    );

    expect(result.status).toBe("denied");
    expect(result.summary).toContain("protected");
  });

  it("requires a recorded plan before model-driven mutations", async () => {
    const ctx = await makeContext();
    const denied = await createDefaultToolBus().execute(
      createToolRequest({
        toolName: "file.write",
        input: { path: "src/index.ts", content: "export const value = 1;\n", createDirs: true },
        source: "model"
      }),
      ctx
    );
    const allowed = await createDefaultToolBus().execute(
      createToolRequest({
        toolName: "file.write",
        input: { path: "src/index.ts", content: "export const value = 1;\n", createDirs: true },
        source: "model"
      }),
      { ...ctx, planApproved: true }
    );

    expect(denied.status).toBe("denied");
    expect(denied.summary).toContain("implementation plan");
    expect(allowed.status).toBe("success");
  });

  it("does not start shell processes when hard sandbox is unavailable", async () => {
    const ctx = await makeContext();
    const seen: string[] = [];
    ctx.eventBus.subscribe((event) => {
      seen.push(event.type);
    });

    const result = await createDefaultToolBus().execute(
      createToolRequest({
        toolName: "shell.run",
        input: { command: "node -e \"console.log('Bearer abcdefghijklmnopqrstuvwxyz')\"" },
        source: "user"
      }),
      { ...ctx, sandbox: new SandboxManager([new TypescriptSandboxAdapter()]) }
    );

    expect(result.status).toBe("denied");
    expect(seen).toContain("sandbox.denied");
    expect(seen).not.toContain("shell.started");
    expect(seen).not.toContain("shell.output");
  });

  it("searches workspace files", async () => {
    const ctx = await makeContext();
    await writeFile(join(ctx.cwd, "package.json"), '{"scripts":{"test":"vitest"}}', "utf8");

    const result = await createDefaultToolBus().execute(
      createToolRequest({
        toolName: "search.files",
        input: { query: "scripts" },
        source: "user"
      }),
      ctx
    );

    expect(result.status).toBe("success");
    expect(result.summary).toContain("Found");
  });

  it("emits enterprise audit records for tool policy decisions", async () => {
    const ctx = await makeContext();
    const seen: string[] = [];
    ctx.eventBus.subscribe((event) => {
      seen.push(event.type);
    });
    const result = await createDefaultToolBus().execute(
      createToolRequest({
        toolName: "search.files",
        input: { query: "missing" },
        source: "user"
      }),
      {
        ...ctx,
        config: { ...ctx.config, telemetry: { ...ctx.config.telemetry, enterpriseAudit: true } }
      }
    );

    expect(result.status).toBe("success");
    expect(seen).toContain("audit.recorded");
  });

  it("calls configured stdio MCP tools through mcp.call", async () => {
    const ctx = await makeContext();
    const serverPath = join(ctx.cwd, "mcp-server.mjs");
    await writeFile(
      serverPath,
      `
let buffer = "";
function send(id, result) {
  const body = JSON.stringify({ jsonrpc: "2.0", id, result });
  process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body);
}
function handle(message) {
  if (message.method === "initialize") {
    send(message.id, { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "test", version: "1.0.0" } });
  }
  if (message.method === "tools/call") {
    send(message.id, { content: [{ type: "text", text: "hello " + message.params.arguments.name }] });
  }
}
function drain() {
  while (true) {
    const marker = buffer.indexOf("\\r\\n\\r\\n");
    if (marker < 0) return;
    const header = buffer.slice(0, marker);
    const match = /content-length:\\s*(\\d+)/i.exec(header);
    if (!match) return;
    const start = marker + 4;
    const length = Number(match[1]);
    if (buffer.slice(start).length < length) return;
    const body = buffer.slice(start, start + length);
    buffer = buffer.slice(start + length);
    handle(JSON.parse(body));
  }
}
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  drain();
});
`,
      "utf8"
    );
    const pinnedCommandSha256 = createHash("sha256")
      .update(await readFile(serverPath))
      .digest("hex");
    await mkdir(join(ctx.cwd, ".nexus"), { recursive: true });
    await writeFile(
      join(ctx.cwd, ".nexus", "mcp.json"),
      JSON.stringify({
        governance: {
          schemaVersion: 1,
          policyVersion: "nexus-mcp-v1",
          remoteRegistries: [],
          updatedAt: "2026-05-23T00:00:00.000Z"
        },
        servers: [
          {
            id: "local",
            name: "Local",
            transport: "stdio",
            command: "node",
            args: [serverPath],
            enabled: true,
            permissions: ["workspace.read"],
            trust: "trusted",
            allowedTools: ["greet"],
            pinnedCommandSha256,
            governance: {
              policyVersion: "nexus-mcp-v1",
              reviewedAt: "2026-05-23T00:00:00.000Z"
            }
          }
        ]
      }),
      "utf8"
    );

    const approvals = new ApprovalCoordinator();
    const execution = createDefaultToolBus().execute(
      createToolRequest({
        toolName: "mcp.call",
        input: { serverId: "local", toolName: "greet", arguments: { name: "nexus" } },
        source: "user"
      }),
      {
        ...ctx,
        approvals,
        nonInteractive: false,
        config: {
          ...ctx.config,
          features: { ...ctx.config.features, mcp: true },
          policy: { ...ctx.config.policy, allowedMcpServers: ["local"] }
        }
      }
    );
    const approval = await waitForApproval(approvals, ctx.sessionId);
    if (!approval) {
      throw new Error("Expected MCP approval request.");
    }
    approvals.decide(approval.id, "approved");
    const result = await execution;

    expect(result.status).toBe("success");
    expect(JSON.stringify(result.output)).toContain("hello nexus");
  });
});

async function makeContext() {
  tempDir = await mkdtemp(join(tmpdir(), "nexus-tool-bus-"));
  return {
    sessionId: "nx_test" as SessionId,
    cwd: tempDir,
    runDirectory: join(tempDir, ".nexus", "runs", "nx_test"),
    config: { ...defaultConfig, sandboxMode: "workspace-write" as const, sources: [] },
    eventBus: new InMemoryEventBus(),
    security: new SecurityRuntime(),
    nonInteractive: true
  };
}

async function waitForApproval(approvals: ApprovalCoordinator, sessionId: SessionId) {
  const started = Date.now();
  while (Date.now() - started < 5000) {
    const approval = approvals.latestPending(sessionId);
    if (approval) {
      return approval;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  return undefined;
}
