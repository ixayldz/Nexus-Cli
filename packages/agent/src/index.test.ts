import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "@nexus/config";
import { InMemoryEventBus } from "@nexus/events";
import {
  DefaultModelRouter,
  type ModelCallInput,
  type ModelCallResult,
  type ModelProvider,
  type ModelProviderCapabilities,
  type ModelStreamEvent,
  ModelProviderRegistry
} from "@nexus/model-router";
import { createDefaultRuntimeServices, NexusRuntime } from "@nexus/runtime";
import { SecurityRuntime } from "@nexus/security";
import { createDefaultToolBus } from "@nexus/tool-bus";
import { MinimalAgentOrchestrator } from "./index.js";

describe("MinimalAgentOrchestrator", () => {
  it("injects compiled repo context and memories into the model call", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nexus-agent-"));
    try {
      await mkdir(join(cwd, "src"), { recursive: true });
      await mkdir(join(cwd, ".nexus", "learning"), { recursive: true });
      await writeFile(
        join(cwd, "package.json"),
        JSON.stringify({ scripts: { test: "vitest run", typecheck: "tsc --noEmit" } }),
        "utf8"
      );
      await writeFile(join(cwd, "pnpm-lock.yaml"), "", "utf8");
      await writeFile(join(cwd, "AGENTS.md"), "Use repository policy from AGENTS.md.\n", "utf8");
      await writeFile(join(cwd, "src", "index.ts"), "export const value = 1;\n", "utf8");
      await writeFile(
        join(cwd, ".nexus", "learning", "project-memory.md"),
        "# Project Memory\n- Prefer pnpm verify before release.\n",
        "utf8"
      );

      const provider = new CapturingModelProvider();
      const registry = new ModelProviderRegistry();
      registry.register(provider);
      const config = {
        ...defaultConfig,
        sources: [],
        modelProvider: provider.id,
        model: "capture-model"
      };
      const services = createDefaultRuntimeServices({
        models: new DefaultModelRouter(registry),
        tools: createDefaultToolBus(),
        security: new SecurityRuntime()
      });
      const runtime = new NexusRuntime({
        config,
        services,
        turnRunner: new MinimalAgentOrchestrator(),
        eventBus: new InMemoryEventBus()
      });

      await runtime.startSession({ cwd, mode: "non-interactive" });
      await runtime.runTurn({
        text: "summarize src/index.ts",
        createdAt: "2026-05-21T00:00:00.000Z"
      });

      const call = provider.calls[0];
      expect(call?.context).toMatchObject({
        repository: {
          packageManager: "pnpm",
          testCommands: ["pnpm test", "pnpm typecheck"]
        }
      });
      expect(call?.messages[0]).toMatchObject({ role: "system" });
      const systemMessage = call?.messages[0]?.content ?? "";
      expect(systemMessage).toContain("Repository context:");
      expect(systemMessage).toContain("Use repository policy from AGENTS.md.");
      expect(systemMessage).toContain("Project memory:");
      expect(systemMessage).toContain("Prefer pnpm verify before release.");
      expect(systemMessage).toContain("src/index.ts");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

class CapturingModelProvider implements ModelProvider {
  public readonly id = "capture";
  public readonly displayName = "Capture";
  public readonly capabilities: ModelProviderCapabilities = {
    supportsStreaming: true,
    supportsToolCalls: true,
    supportsImages: false,
    supportsReasoningSummaries: false
  };
  public readonly calls: ModelCallInput[] = [];

  public async call(input: ModelCallInput): Promise<ModelCallResult> {
    this.calls.push(input);
    return { message: "captured", toolCalls: [] };
  }

  public async *stream(input: ModelCallInput): AsyncIterable<ModelStreamEvent> {
    this.calls.push(input);
    yield { type: "token", text: "captured" };
    yield { type: "completed" };
  }
}
