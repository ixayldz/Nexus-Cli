import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "@nexus/config";
import { ContextCompiler } from "./index.js";

describe("ContextCompiler", () => {
  it("discovers repo context, memories, mentions, and token budget", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nexus-context-"));
    const userMemoryRoot = await mkdtemp(join(tmpdir(), "nexus-user-memory-"));
    try {
      await writeFile(
        join(cwd, "package.json"),
        JSON.stringify({ scripts: { test: "vitest run", typecheck: "tsc --noEmit" } }),
        "utf8"
      );
      await writeFile(join(cwd, "pnpm-lock.yaml"), "", "utf8");
      await writeFile(join(cwd, "AGENTS.md"), "Use focused tests.", "utf8");
      await writeFile(join(cwd, "src-index.ts"), "export const value = 1;\n", "utf8");
      await mkdir(join(cwd, ".nexus", "learning"), { recursive: true });
      await writeFile(join(cwd, ".nexus", "learning", "project-memory.md"), "# Project Memory\n\n- use tests\n", "utf8");
    } catch {
      await rm(cwd, { recursive: true, force: true });
      await rm(userMemoryRoot, { recursive: true, force: true });
      throw new Error("context fixture setup failed");
    }

    try {
      await writeFile(join(userMemoryRoot, "user-memory.md"), "# User Memory\n\n- prefer concise output\n", "utf8");
      const context = await new ContextCompiler({ userMemoryRoot }).compile({
        cwd,
        config: { ...defaultConfig, sources: [] },
        prompt: "Inspect src-index.ts"
      });

      expect(context.repository.packageManager).toBe("pnpm");
      expect(context.repository.testCommands).toEqual(["pnpm test", "pnpm typecheck"]);
      expect(context.repository.repoMap.files.some((file) => file.path === "package.json")).toBe(true);
      expect(context.mentions).toContainEqual(expect.objectContaining({ mention: "src-index.ts", exists: true }));
      expect(context.memories.project).toContain("Project Memory");
      expect(context.memories.user).toContain("User Memory");
      expect(context.tokenBudget.estimatedInputTokens).toBeGreaterThan(0);
      expect(context.compactSummary).toContain("packageManager=pnpm");
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(userMemoryRoot, { recursive: true, force: true });
    }
  });
});
