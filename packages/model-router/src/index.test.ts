import { describe, expect, it } from "vitest";
import { InMemoryEventBus } from "@nexus/events";
import { type SessionId, type ToolCallId, createId, setIdCounterForTests } from "@nexus/shared";
import {
  DefaultModelRouter,
  type ModelCallResult,
  type ModelProvider,
  type ModelStreamEvent,
  ModelProviderRegistry,
  nexusToolDefinitions
} from "./index.js";

describe("model router", () => {
  it("emits model events and returns fake provider tool calls", async () => {
    setIdCounterForTests(1);
    const registry = new ModelProviderRegistry();
    registry.register(new TestModelProvider());
    const router = new DefaultModelRouter(registry);
    const bus = new InMemoryEventBus();
    const seen: string[] = [];
    bus.subscribe((event) => {
      seen.push(event.type);
    });

    const result = await router.call({
      providerId: "fake",
      sessionId: "nx_test" as SessionId,
      model: "fake-default",
      messages: [{ role: "user", content: "Read package.json and summarize it" }],
      eventBus: bus
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(seen).toEqual(["model.call.started", "model.call.completed"]);
    setIdCounterForTests(undefined);
  });

  it("normalizes provider errors and emits failed completion events", async () => {
    const registry = new ModelProviderRegistry();
    registry.register(new FailingModelProvider());
    const router = new DefaultModelRouter(registry);
    const bus = new InMemoryEventBus();
    const seen: Array<{ type: string; status?: unknown; message?: unknown }> = [];
    bus.subscribe((event) => {
      seen.push({ type: event.type, status: event.status, message: event.message });
    });

    await expect(
      router.call({
        providerId: "failing",
        sessionId: "nx_test" as SessionId,
        model: "test",
        messages: [{ role: "user", content: "hello" }],
        eventBus: bus
      })
    ).rejects.toMatchObject({ providerId: "failing", message: "provider failed with [REDACTED]" });

    expect(seen).toEqual([
      { type: "model.call.started", status: undefined, message: undefined },
      { type: "model.call.failed", status: undefined, message: "provider failed with [REDACTED]" },
      { type: "model.call.completed", status: "failed", message: "provider failed with [REDACTED]" }
    ]);
  });

  it("streams provider deltas through observable router events", async () => {
    const registry = new ModelProviderRegistry();
    registry.register(new StreamingModelProvider());
    const router = new DefaultModelRouter(registry);
    const bus = new InMemoryEventBus();
    const seen: string[] = [];
    bus.subscribe((event) => {
      seen.push(event.type);
    });

    const tokens: string[] = [];
    for await (const event of router.stream({
      providerId: "streaming",
      sessionId: "nx_test" as SessionId,
      model: "test",
      messages: [{ role: "user", content: "hello" }],
      eventBus: bus
    })) {
      if (event.text) {
        tokens.push(event.text);
      }
    }

    expect(tokens.join("")).toBe("hello");
    expect(seen).toEqual([
      "model.stream.started",
      "model.stream.delta",
      "assistant.delta",
      "model.stream.delta",
      "assistant.delta",
      "model.stream.completed",
      "model.usage"
    ]);
  });

  it("exposes canonical Nexus tool definitions", () => {
    expect(nexusToolDefinitions().map((definition) => definition.name)).toContain("test.run");
    expect(nexusToolDefinitions().map((definition) => definition.name)).toContain("mcp.call");
  });

  it("denies providers and models outside router policy", async () => {
    const registry = new ModelProviderRegistry();
    registry.register(new TestModelProvider());
    const router = new DefaultModelRouter(registry, { allowedProviders: ["deepseek"], allowedModels: ["deepseek-v4-flash"] });

    await expect(
      router.call({
        providerId: "fake",
        sessionId: "nx_test" as SessionId,
        model: "fake-default",
        messages: [{ role: "user", content: "hello" }],
        eventBus: new InMemoryEventBus()
      })
    ).rejects.toMatchObject({ providerId: "fake" });
  });
});

class TestModelProvider implements ModelProvider {
  public readonly id = "fake";
  public readonly displayName = "Test Model";
  public readonly capabilities = {
    supportsStreaming: true,
    supportsToolCalls: true,
    supportsImages: false,
    supportsReasoningSummaries: false
  };

  public async call(): Promise<ModelCallResult> {
    return {
      message: "tool requested",
      toolCalls: [
        {
          id: createId("tool") as unknown as ToolCallId,
          name: "file.read",
          input: { path: "package.json" }
        }
      ]
    };
  }

  public async *stream(): AsyncIterable<ModelStreamEvent> {
    yield { type: "completed" };
  }
}

class FailingModelProvider implements ModelProvider {
  public readonly id = "failing";
  public readonly displayName = "Failing Model";
  public readonly capabilities = {
    supportsStreaming: false,
    supportsToolCalls: false,
    supportsImages: false,
    supportsReasoningSummaries: false
  };

  public async call(): Promise<ModelCallResult> {
    throw new Error("provider failed with sk-secret123456");
  }

  public async *stream(): AsyncIterable<ModelStreamEvent> {
    yield { type: "completed" };
  }
}

class StreamingModelProvider implements ModelProvider {
  public readonly id = "streaming";
  public readonly displayName = "Streaming Model";
  public readonly capabilities = {
    supportsStreaming: true,
    supportsToolCalls: false,
    supportsImages: false,
    supportsReasoningSummaries: false
  };

  public async call(): Promise<ModelCallResult> {
    return { message: "hello", toolCalls: [] };
  }

  public async *stream(): AsyncIterable<ModelStreamEvent> {
    yield { type: "token", text: "he" };
    yield { type: "token", text: "llo" };
    yield { type: "completed" };
  }
}
