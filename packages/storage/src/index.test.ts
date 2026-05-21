import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type SessionId } from "@nexus/shared";
import { createSessionStorage } from "./index.js";

let tempDir: string | undefined;
let externalDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
  if (externalDir) {
    await rm(externalDir, { recursive: true, force: true });
    externalDir = undefined;
  }
});

describe("session storage", () => {
  it("creates run directories and round-trips manifest", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "nexus-storage-"));
    const storage = await createSessionStorage({ cwd: tempDir, sessionId: "nx_test" as SessionId });

    await storage.writeManifest({
      sessionId: "nx_test" as SessionId,
      startedAt: "2026-05-20T00:00:00.000Z",
      cwd: tempDir,
      mode: "non-interactive",
      eventLogPath: storage.eventLogPath,
      filesChanged: [],
      commandsRun: []
    });

    await expect(storage.readManifest()).resolves.toMatchObject({ sessionId: "nx_test" });
  });

  it("rejects a project .nexus directory that is a symlink", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "nexus-storage-"));
    externalDir = await mkdtemp(join(tmpdir(), "nexus-storage-external-"));
    try {
      await symlink(externalDir, join(tempDir, ".nexus"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      return;
    }

    await expect(createSessionStorage({ cwd: tempDir, sessionId: "nx_test" as SessionId })).rejects.toThrow(
      ".nexus project storage must not be a symlink"
    );
  });
});
