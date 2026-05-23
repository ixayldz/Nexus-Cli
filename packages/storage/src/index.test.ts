import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type SessionId } from "@nexus/shared";
import { createSessionStorage, safeAtomicWriteText, safeReadTextFile } from "./index.js";

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
      await symlink(
        externalDir,
        join(tempDir, ".nexus"),
        process.platform === "win32" ? "junction" : "dir"
      );
    } catch {
      return;
    }

    await expect(
      createSessionStorage({ cwd: tempDir, sessionId: "nx_test" as SessionId })
    ).rejects.toThrow(".nexus project storage must not be a symlink");
  });

  it("rejects symlinked session artifact targets", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "nexus-storage-"));
    externalDir = await mkdtemp(join(tmpdir(), "nexus-storage-external-"));
    const storage = await createSessionStorage({ cwd: tempDir, sessionId: "nx_test" as SessionId });
    const externalFile = join(externalDir, "outside.txt");
    await writeFile(externalFile, "outside\n", "utf8");
    try {
      await symlink(externalFile, storage.artifacts.finalAnswerPath, "file");
    } catch {
      return;
    }

    await expect(storage.writeArtifact("finalAnswerPath", "new\n")).rejects.toThrow(
      "Write target must not be a symlink"
    );
    await expect(readFile(externalFile, "utf8")).resolves.toBe("outside\n");
  });

  it("rejects symlinked parents that resolve outside the workspace", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "nexus-storage-"));
    externalDir = await mkdtemp(join(tmpdir(), "nexus-storage-external-"));
    const root = join(tempDir, ".nexus");
    await mkdir(root, { recursive: true });
    try {
      await symlink(
        externalDir,
        join(root, "escape"),
        process.platform === "win32" ? "junction" : "dir"
      );
    } catch {
      return;
    }

    await expect(
      safeAtomicWriteText({
        path: join(root, "escape", "artifact.txt"),
        allowedRoot: root,
        workspaceRoot: tempDir,
        content: "blocked\n"
      })
    ).rejects.toThrow("write target parent must not be a symlink");
  });

  it("rejects a symlinked .nexus runs directory before creating a session", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "nexus-storage-"));
    externalDir = await mkdtemp(join(tmpdir(), "nexus-storage-external-"));
    await mkdir(join(tempDir, ".nexus"), { recursive: true });
    try {
      await symlink(
        externalDir,
        join(tempDir, ".nexus", "runs"),
        process.platform === "win32" ? "junction" : "dir"
      );
    } catch {
      return;
    }

    await expect(
      createSessionStorage({ cwd: tempDir, sessionId: "nx_test" as SessionId })
    ).rejects.toThrow(".nexus runs directory must not be a symlink");
  });

  it("writes atomically inside the allowed storage root", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "nexus-storage-"));
    const root = join(tempDir, ".nexus");
    const path = join(root, "runs", "nx_test", "artifact.txt");

    await safeAtomicWriteText({
      path,
      allowedRoot: root,
      workspaceRoot: tempDir,
      content: "ok\n"
    });

    await expect(readFile(path, "utf8")).resolves.toBe("ok\n");
  });

  it("reads text only through the allowed storage root without following symlink targets", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "nexus-storage-"));
    externalDir = await mkdtemp(join(tmpdir(), "nexus-storage-external-"));
    const root = join(tempDir, ".nexus");
    const path = join(root, "artifact.txt");
    await mkdir(root, { recursive: true });
    await writeFile(path, "ok\n", "utf8");

    await expect(
      safeReadTextFile({ path, allowedRoot: root, workspaceRoot: tempDir })
    ).resolves.toBe("ok\n");

    const externalFile = join(externalDir, "outside.txt");
    await writeFile(externalFile, "outside\n", "utf8");
    await rm(path);
    try {
      await symlink(externalFile, path, "file");
    } catch {
      return;
    }

    await expect(
      safeReadTextFile({ path, allowedRoot: root, workspaceRoot: tempDir })
    ).rejects.toThrow("Read target must not be a symlink");
  });

  it("rejects invalid session ids before creating run directories", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "nexus-storage-"));

    for (const sessionId of [
      "../escape",
      "nx_bad/child",
      "nx_bad\\child",
      "nx_.",
      "nx_",
      "session_123",
      ""
    ]) {
      await expect(
        createSessionStorage({ cwd: tempDir, sessionId: sessionId as SessionId })
      ).rejects.toThrow("Invalid session id");
    }

    await expect(readFile(join(tempDir, ".nexus", "runs", "escape"), "utf8")).rejects.toThrow();
  });
});
