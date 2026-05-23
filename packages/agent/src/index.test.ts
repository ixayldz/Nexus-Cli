import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig, type ResolvedConfig } from "@nexus/config";
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
import { createDefaultRuntimeServices, NexusRuntime, type RuntimeServices } from "@nexus/runtime";
import { SecurityRuntime } from "@nexus/security";
import { type ToolCallId, createId } from "@nexus/shared";
import { createDefaultToolBus } from "@nexus/tool-bus";
import { MinimalAgentOrchestrator, SubagentManager } from "./index.js";

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

      const call = provider.calls.find((candidate) =>
        candidate.messages.some((message) => message.content.includes("Repository context:"))
      );
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

  it("continues long workflows beyond three sequential tool calls", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nexus-agent-"));
    try {
      await writeFile(join(cwd, "alpha.txt"), "alpha beta gamma delta", "utf8");
      const provider = new LongWorkflowProvider();
      const eventBus = new InMemoryEventBus();
      const seenEvents: string[] = [];
      eventBus.subscribe((event) => {
        seenEvents.push(event.type);
      });
      const { runtime } = createRuntimeFixture({ cwd, provider, eventBus });

      await runtime.startSession({ cwd, mode: "non-interactive" });
      const result = await runtime.runTurn({
        text: "search alpha beta gamma delta",
        createdAt: "2026-05-21T00:00:00.000Z"
      });

      expect(seenEvents.filter((type) => type === "tool.requested")).toHaveLength(4);
      expect(result.finalMessage).toContain("Searched all requested terms");
      expect(result.exitCodeHint).toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("stops repeated failed tool calls instead of looping indefinitely", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nexus-agent-"));
    try {
      const provider = new RepeatingFailureProvider();
      const eventBus = new InMemoryEventBus();
      const seenEvents: string[] = [];
      eventBus.subscribe((event) => {
        seenEvents.push(event.type);
      });
      const { runtime } = createRuntimeFixture({ cwd, provider, eventBus });

      await runtime.startSession({ cwd, mode: "non-interactive" });
      const result = await runtime.runTurn({
        text: "repeat failing tool",
        createdAt: "2026-05-21T00:00:00.000Z"
      });

      expect(seenEvents.filter((type) => type === "tool.requested")).toHaveLength(2);
      expect(seenEvents).toContain("agent.step.blocked");
      expect(result.finalMessage).toContain("Repeated failed or denied tool call");
      expect(result.exitCodeHint).toBeGreaterThan(0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("runs a critic pass after a mutating workflow", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nexus-agent-"));
    try {
      const provider = new MutationWithCriticProvider();
      const eventBus = new InMemoryEventBus();
      const seenEvents: string[] = [];
      eventBus.subscribe((event) => {
        seenEvents.push(event.type);
      });
      const { runtime } = createRuntimeFixture({
        cwd,
        provider,
        eventBus,
        configOverrides: {
          sdlc: { ...defaultConfig.sdlc, requirePlanForLargeChanges: false }
        }
      });

      await runtime.startSession({ cwd, mode: "non-interactive" });
      const result = await runtime.runTurn({
        text: "write critic target",
        createdAt: "2026-05-21T00:00:00.000Z"
      });

      await expect(readFile(join(cwd, "src", "critic-target.ts"), "utf8")).resolves.toContain(
        "criticTarget"
      );
      expect(seenEvents).toContain("agent.critic.completed");
      expect(result.finalMessage).toContain("Mutation completed");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("blocks non-interactive model mutations without explicit automation approval policy", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nexus-agent-"));
    try {
      const provider = new MutationWithCriticProvider();
      const eventBus = new InMemoryEventBus();
      const { runtime } = createRuntimeFixture({
        cwd,
        provider,
        eventBus,
        configOverrides: {
          approvalPolicy: "on-request",
          sandboxMode: "workspace-write"
        }
      });

      await runtime.startSession({ cwd, mode: "non-interactive" });
      const result = await runtime.runTurn({
        text: "write critic target",
        createdAt: "2026-05-21T00:00:00.000Z"
      });

      expect(result.exitCodeHint).toBe(2);
      await expect(readFile(join(cwd, "src", "critic-target.ts"), "utf8")).rejects.toThrow();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("executes tool calls requested by a critic follow-up", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nexus-agent-"));
    try {
      await writeFile(join(cwd, "follow-up.txt"), "follow-up", "utf8");
      const provider = new CriticContinueProvider();
      const eventBus = new InMemoryEventBus();
      const seenEvents: string[] = [];
      eventBus.subscribe((event) => {
        seenEvents.push(event.type);
      });
      const { runtime } = createRuntimeFixture({
        cwd,
        provider,
        eventBus,
        configOverrides: {
          agent: { ...defaultConfig.agent, criticMode: "always" }
        }
      });

      await runtime.startSession({ cwd, mode: "non-interactive" });
      const result = await runtime.runTurn({
        text: "answer after critic follow-up",
        createdAt: "2026-05-21T00:00:00.000Z"
      });

      expect(seenEvents.filter((type) => type === "tool.requested")).toHaveLength(1);
      expect(result.finalMessage).toContain("Follow-up search complete");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("runs read-only subagents through the runtime and denies mutation attempts", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nexus-agent-"));
    try {
      const provider = new MutatingSubagentProvider();
      const eventBus = new InMemoryEventBus();
      const seenEvents: string[] = [];
      eventBus.subscribe((event) => {
        seenEvents.push(event.type);
      });
      const { runtime, config, services } = createRuntimeFixture({ cwd, provider, eventBus });
      const session = await runtime.startSession({ cwd, mode: "non-interactive" });

      const result = await new SubagentManager().run({
        name: "Read Only Review",
        role: "reviewer",
        prompt: "Try to write a file while reviewing.",
        permissionProfile: "read-only",
        session,
        runtimeContext: {
          session,
          config,
          eventBus,
          storage: runtime.getStorage(),
          services,
          nonInteractive: true
        }
      });

      expect(result.status).toBe("completed");
      expect(result.summary).toContain("Denied mutation as expected");
      await expect(readFile(join(cwd, "src", "subagent.ts"), "utf8")).rejects.toThrow();
      expect(seenEvents).toContain("subagent.started");
      expect(seenEvents).toContain("subagent.completed");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("requires runtime context for subagent execution", async () => {
    await expect(
      new SubagentManager().run({
        name: "No Runtime",
        role: "explorer",
        prompt: "summarize",
        permissionProfile: "read-only"
      } as never)
    ).rejects.toThrow("requires a runtime session");
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

class LongWorkflowProvider implements ModelProvider {
  public readonly id = "long-workflow";
  public readonly displayName = "Long Workflow";
  public readonly capabilities = providerCapabilities();

  public async call(input: ModelCallInput): Promise<ModelCallResult> {
    if (isPlannerCall(input)) {
      return planResult();
    }
    const nextQuery = ["alpha", "beta", "gamma", "delta"][input.observations?.length ?? 0];
    if (nextQuery) {
      return {
        message: `Searching ${nextQuery}.`,
        toolCalls: [
          {
            id: createId("tool") as unknown as ToolCallId,
            name: "search.files",
            input: { query: nextQuery, maxResults: 10 }
          }
        ]
      };
    }
    return { message: "Searched all requested terms.", toolCalls: [] };
  }

  public async *stream(input: ModelCallInput): AsyncIterable<ModelStreamEvent> {
    yield { type: "token", text: (await this.call(input)).message };
    yield { type: "completed" };
  }
}

class RepeatingFailureProvider implements ModelProvider {
  public readonly id = "repeat-failure";
  public readonly displayName = "Repeat Failure";
  public readonly capabilities = providerCapabilities();

  public async call(input: ModelCallInput): Promise<ModelCallResult> {
    if (isPlannerCall(input)) {
      return planResult();
    }
    return {
      message: "Trying the same unavailable tool.",
      toolCalls: [
        {
          id: createId("tool") as unknown as ToolCallId,
          name: "missing.tool",
          input: { target: "same" }
        }
      ]
    };
  }

  public async *stream(input: ModelCallInput): AsyncIterable<ModelStreamEvent> {
    yield { type: "token", text: (await this.call(input)).message };
    yield { type: "completed" };
  }
}

class MutationWithCriticProvider implements ModelProvider {
  public readonly id = "mutation-critic";
  public readonly displayName = "Mutation Critic";
  public readonly capabilities = providerCapabilities();

  public async call(input: ModelCallInput): Promise<ModelCallResult> {
    if (isCriticCall(input)) {
      return {
        message: JSON.stringify({
          decision: "finalize",
          summary: "Critic verified the mutation.",
          reasons: ["mutation_completed"]
        }),
        toolCalls: []
      };
    }
    if (isPlannerCall(input)) {
      return planResult({ requiresMutation: true });
    }
    if ((input.observations?.length ?? 0) === 0) {
      return {
        message: "Writing critic target.",
        toolCalls: [
          {
            id: createId("tool") as unknown as ToolCallId,
            name: "file.write",
            input: {
              path: "src/critic-target.ts",
              content: "export const criticTarget = true;\n",
              createDirs: true
            }
          }
        ]
      };
    }
    return { message: "Mutation completed.", toolCalls: [] };
  }

  public async *stream(input: ModelCallInput): AsyncIterable<ModelStreamEvent> {
    yield { type: "token", text: (await this.call(input)).message };
    yield { type: "completed" };
  }
}

class MutatingSubagentProvider implements ModelProvider {
  public readonly id = "mutating-subagent";
  public readonly displayName = "Mutating Subagent";
  public readonly capabilities = providerCapabilities();

  public async call(input: ModelCallInput): Promise<ModelCallResult> {
    if ((input.observations?.length ?? 0) > 0) {
      return { message: "Denied mutation as expected.", toolCalls: [] };
    }
    return {
      message: "Attempting mutation.",
      toolCalls: [
        {
          id: createId("tool") as unknown as ToolCallId,
          name: "file.write",
          input: {
            path: "src/subagent.ts",
            content: "export const unsafe = true;\n",
            createDirs: true
          }
        }
      ]
    };
  }

  public async *stream(input: ModelCallInput): AsyncIterable<ModelStreamEvent> {
    yield { type: "token", text: (await this.call(input)).message };
    yield { type: "completed" };
  }
}

class CriticContinueProvider implements ModelProvider {
  public readonly id = "critic-continue";
  public readonly displayName = "Critic Continue";
  public readonly capabilities = providerCapabilities();

  public async call(input: ModelCallInput): Promise<ModelCallResult> {
    if (isCriticCall(input)) {
      return {
        message: JSON.stringify({
          decision: "continue",
          summary: "Search for follow-up evidence.",
          reasons: ["missing_evidence"],
          followUpPrompt: "Search follow-up.txt"
        }),
        toolCalls: []
      };
    }
    if (isPlannerCall(input)) {
      return planResult();
    }
    if ((input.observations?.length ?? 0) > 0) {
      return { message: "Follow-up search complete.", toolCalls: [] };
    }
    if (input.messages.some((message) => message.content.includes("Critic follow-up required"))) {
      return {
        message: "Searching follow-up evidence.",
        toolCalls: [
          {
            id: createId("tool") as unknown as ToolCallId,
            name: "search.files",
            input: { query: "follow-up", maxResults: 10 }
          }
        ]
      };
    }
    return { message: "Initial answer needs critic review.", toolCalls: [] };
  }

  public async *stream(input: ModelCallInput): AsyncIterable<ModelStreamEvent> {
    yield { type: "token", text: (await this.call(input)).message };
    yield { type: "completed" };
  }
}

function createRuntimeFixture(input: {
  cwd: string;
  provider: ModelProvider;
  eventBus: InMemoryEventBus;
  configOverrides?: Partial<ResolvedConfig>;
}): {
  runtime: NexusRuntime;
  config: ResolvedConfig;
  services: RuntimeServices;
} {
  const registry = new ModelProviderRegistry();
  registry.register(input.provider);
  const config: ResolvedConfig = {
    ...defaultConfig,
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    ...input.configOverrides,
    sources: [],
    modelProvider: input.provider.id,
    model: "test-model"
  };
  const services = createDefaultRuntimeServices({
    models: new DefaultModelRouter(registry),
    tools: createDefaultToolBus(),
    security: new SecurityRuntime()
  });
  return {
    runtime: new NexusRuntime({
      config,
      services,
      turnRunner: new MinimalAgentOrchestrator(),
      eventBus: input.eventBus
    }),
    config,
    services
  };
}

function isPlannerCall(input: ModelCallInput): boolean {
  return (
    input.tools?.length === 0 &&
    input.messages.some((message) => message.content.includes("agent execution plan"))
  );
}

function isCriticCall(input: ModelCallInput): boolean {
  return (
    input.tools?.length === 0 &&
    input.messages.some((message) => message.content.includes("Nexus critic"))
  );
}

function planResult(overrides: { requiresMutation?: boolean } = {}): ModelCallResult {
  return {
    message: JSON.stringify({
      summary: "Test plan",
      steps: ["Inspect", "Execute", "Verify"],
      risks: [],
      verification: [],
      approvalRequirements: [],
      files: [],
      allowedTools: ["search.files", "file.write"],
      requiresMutation: overrides.requiresMutation ?? false
    }),
    toolCalls: []
  };
}

function providerCapabilities(): ModelProviderCapabilities {
  return {
    supportsStreaming: true,
    supportsToolCalls: true,
    supportsImages: false,
    supportsReasoningSummaries: false
  };
}
