import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryEventBus } from "@nexus/events";
import { type SessionId } from "@nexus/shared";
import { HookRegistry, HookRunner } from "./index.js";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("hook registry", () => {
  it("loads configured lifecycle hooks", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "nexus-hooks-"));
    await mkdir(join(tempDir, ".nexus"));
    await writeFile(
      join(tempDir, ".nexus", "hooks.json"),
      JSON.stringify({
        hooks: [
          {
            id: "verify",
            event: "before_verify",
            command: "node --version",
            enabled: true,
            requiredPermissions: []
          }
        ]
      }),
      "utf8"
    );

    await expect(new HookRegistry().list(tempDir)).resolves.toEqual([
      {
        id: "verify",
        event: "before_verify",
        command: "node --version",
        enabled: true,
        requiredPermissions: []
      }
    ]);
  });

  it("does not execute hooks unless the hooks feature is enabled", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "nexus-hooks-"));
    await writeHookConfig(tempDir, []);

    const result = await new HookRunner().run({
      cwd: tempDir,
      sessionId: "nx_test" as SessionId,
      point: "before_verify",
      tools: unexpectedTools(),
      ctx: makeHookContext(tempDir, false)
    });

    expect(result).toBe(0);
  });

  it("enforces required hook permissions before execution", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "nexus-hooks-"));
    await writeHookConfig(tempDir, ["network.access"]);
    const ctx = makeHookContext(tempDir, true);
    const seen: string[] = [];
    ctx.eventBus.subscribe((event: { type: string }) => {
      seen.push(event.type);
    });

    await expect(
      new HookRunner().run({
        cwd: tempDir,
        sessionId: "nx_test" as SessionId,
        point: "before_verify",
        tools: unexpectedTools(),
        ctx
      })
    ).rejects.toThrow("missing permission 'network.access'");
    expect(seen).toContain("audit.recorded");
  });
});

async function writeHookConfig(cwd: string, requiredPermissions: string[]): Promise<void> {
  await mkdir(join(cwd, ".nexus"), { recursive: true });
  await writeFile(
    join(cwd, ".nexus", "hooks.json"),
    JSON.stringify({
      hooks: [
        {
          id: "verify",
          event: "before_verify",
          command: "node --version",
          enabled: true,
          required: true,
          requiredPermissions
        }
      ]
    }),
    "utf8"
  );
}

function makeHookContext(cwd: string, hooksEnabled: boolean) {
  return {
    sessionId: "nx_test" as SessionId,
    cwd,
    runDirectory: join(cwd, ".nexus", "runs", "nx_test"),
    config: {
      features: { hooks: hooksEnabled },
      approvalPolicy: "on-request",
      sandboxMode: "workspace-write",
      security: { networkDefault: "off" }
    },
    eventBus: new InMemoryEventBus(),
    nonInteractive: true
  } as any;
}

function unexpectedTools() {
  return {
    execute: async () => {
      throw new Error("Hook command should not execute.");
    }
  } as any;
}
