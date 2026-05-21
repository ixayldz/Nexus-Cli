import { readFile, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ContextCompiler } from "@nexus/context";
import { defaultConfig } from "@nexus/config";
import { InMemoryEventBus } from "@nexus/events";
import { type SessionId } from "@nexus/shared";
import { LearningPlane } from "./index.js";

describe("LearningPlane", () => {
  it("creates candidates and writes accepted project memory", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nexus-learning-"));
    try {
      await writeFile(
        join(cwd, "package.json"),
        JSON.stringify({ scripts: { test: "vitest run" } }),
        "utf8"
      );
      await writeFile(join(cwd, "pnpm-lock.yaml"), "", "utf8");
      const context = await new ContextCompiler().compile({ cwd, config: { ...defaultConfig, sources: [] } });
      const events: string[] = [];
      const eventBus = new InMemoryEventBus();
      eventBus.subscribe((event) => {
        events.push(event.type);
      });
      const plane = new LearningPlane({ mode: "suggest" });

      const candidates = await plane.generateCandidates({
        sessionId: "nx_test" as SessionId,
        eventBus,
        context,
        commandsRun: ["pnpm test"],
        filesChanged: ["packages/learning/src/index.ts"]
      });
      const entries = await plane.acceptPending({
        sessionId: "nx_test" as SessionId,
        eventBus,
        cwd
      });
      const memory = await plane.readProjectMemory(cwd);

      expect(candidates.length).toBeGreaterThan(0);
      expect(entries.length).toBe(candidates.length);
      expect(memory).toContain("Project Memory");
      expect(memory).toContain("pnpm");
      expect(events).toContain("learning.candidate.created");
      expect(events).toContain("memory.written");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not generate candidates when learning is off", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nexus-learning-"));
    try {
      const context = await new ContextCompiler().compile({ cwd, config: { ...defaultConfig, sources: [] } });
      const candidates = await new LearningPlane({ mode: "off" }).generateCandidates({
        sessionId: "nx_test" as SessionId,
        eventBus: new InMemoryEventBus(),
        context,
        commandsRun: [],
        filesChanged: []
      });

      expect(candidates).toEqual([]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("writes scoped user memory and structured project stores only after acceptance", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nexus-learning-"));
    const userMemoryRoot = await mkdtemp(join(tmpdir(), "nexus-user-memory-"));
    try {
      await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }), "utf8");
      await writeFile(join(cwd, "pnpm-lock.yaml"), "", "utf8");
      const context = await new ContextCompiler({ userMemoryRoot }).compile({
        cwd,
        config: { ...defaultConfig, sources: [] }
      });
      const plane = new LearningPlane({ mode: "active", userMemoryRoot });

      const candidates = await plane.generateCandidates({
        sessionId: "nx_test" as SessionId,
        eventBus: new InMemoryEventBus(),
        context,
        commandsRun: ["pnpm test"],
        filesChanged: ["src/feature.ts"]
      });
      expect(plane.getState().effectiveMode).toBe("suggest");
      expect(candidates.some((candidate) => candidate.scope === "user")).toBe(true);

      const entries = await plane.acceptPending({
        sessionId: "nx_test" as SessionId,
        eventBus: new InMemoryEventBus(),
        cwd,
        candidateIds: candidates.map((candidate) => candidate.id)
      });
      const userMemory = await plane.readUserMemory();
      const workflows = await readFile(join(cwd, ".nexus", "learning", "workflows.json"), "utf8");

      expect(entries.length).toBe(candidates.length);
      expect(userMemory).toContain("Prefer pnpm commands");
      expect(workflows).toContain("pnpm test");
      expect(await plane.listMemories(cwd)).not.toHaveLength(0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(userMemoryRoot, { recursive: true, force: true });
    }
  });

  it("edits and deletes memories loaded from persisted markdown", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nexus-learning-"));
    const userMemoryRoot = await mkdtemp(join(tmpdir(), "nexus-user-memory-"));
    try {
      await writeFile(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }), "utf8");
      await writeFile(join(cwd, "pnpm-lock.yaml"), "", "utf8");
      const context = await new ContextCompiler({ userMemoryRoot }).compile({
        cwd,
        config: { ...defaultConfig, sources: [] }
      });
      const eventBus = new InMemoryEventBus();
      const firstPlane = new LearningPlane({ mode: "suggest", userMemoryRoot });
      const candidates = await firstPlane.generateCandidates({
        sessionId: "nx_test" as SessionId,
        eventBus,
        context,
        commandsRun: ["pnpm test"],
        filesChanged: ["src/feature.ts"]
      });
      const [entry] = await firstPlane.acceptPending({
        sessionId: "nx_test" as SessionId,
        eventBus,
        cwd,
        candidateIds: candidates.map((candidate) => candidate.id)
      });
      if (!entry) {
        throw new Error("Expected accepted memory.");
      }

      const secondPlane = new LearningPlane({ mode: "suggest", userMemoryRoot });
      const edited = await secondPlane.editMemory({
        sessionId: "nx_test" as SessionId,
        eventBus,
        cwd,
        memoryId: entry.id,
        text: "Use pnpm verify for release checks."
      });
      expect(edited?.text).toContain("pnpm verify");
      await expect(readFile(join(cwd, ".nexus", "learning", "project-memory.md"), "utf8")).resolves.toContain("pnpm verify");

      const deleted = await secondPlane.deleteMemory({
        sessionId: "nx_test" as SessionId,
        eventBus,
        cwd,
        memoryId: entry.id
      });
      expect(deleted?.id).toBe(entry.id);
      await expect(readFile(join(cwd, ".nexus", "learning", "project-memory.md"), "utf8")).resolves.not.toContain(
        "pnpm verify"
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(userMemoryRoot, { recursive: true, force: true });
    }
  });

  it("rejects project learning storage when .nexus is a symlink", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nexus-learning-"));
    const external = await mkdtemp(join(tmpdir(), "nexus-learning-external-"));
    try {
      try {
        await symlink(external, join(cwd, ".nexus"), process.platform === "win32" ? "junction" : "dir");
      } catch {
        return;
      }

      await expect(new LearningPlane({ mode: "suggest" }).readProjectMemory(cwd)).rejects.toThrow(
        ".nexus learning storage must not be a symlink"
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(external, { recursive: true, force: true });
    }
  });
});
