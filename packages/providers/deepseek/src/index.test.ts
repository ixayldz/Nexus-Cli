import { describe, expect, it } from "vitest";
import { type SessionId } from "@nexus/shared";
import { DeepSeekChatProvider, loadDeepSeekAuth, normalizeDeepSeekResponse } from "./index.js";

describe("DeepSeek provider", () => {
  it("loads API key from DEEPSEEK_API_KEY", async () => {
    await expect(
      loadDeepSeekAuth({ env: { DEEPSEEK_API_KEY: "test-key" } })
    ).resolves.toMatchObject({
      apiKey: "test-key",
      source: "environment"
    });
  });

  it("normalizes chat completion tool calls", () => {
    const result = normalizeDeepSeekResponse({
      choices: [
        {
          message: {
            role: "assistant",
            content: "I will read the file.",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "file__read", arguments: '{"path":"package.json"}' }
              }
            ]
          }
        }
      ],
      usage: { prompt_tokens: 7, completion_tokens: 11 }
    });

    expect(result.message).toBe("I will read the file.");
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 11 });
    expect(result.toolCalls).toEqual([
      { id: "call_1", name: "file.read", input: { path: "package.json" } }
    ]);
  });

  it("sends OpenAI-compatible chat completion requests to DeepSeek", async () => {
    let captured: { url: string; body: Record<string, unknown>; authorization: string } | undefined;
    const provider = new DeepSeekChatProvider({
      env: { DEEPSEEK_API_KEY: "test-key" },
      fetch: async (url, init) => {
        captured = {
          url,
          body: JSON.parse(String(init.body)) as Record<string, unknown>,
          authorization: new Headers(init.headers).get("authorization") ?? ""
        };
        return new Response(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "ok", tool_calls: [] } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
    });

    const result = await provider.call({
      sessionId: "nx_test" as SessionId,
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "hello" }]
    });

    expect(result.message).toBe("ok");
    expect(captured?.url).toBe("https://api.deepseek.com/chat/completions");
    expect(captured?.authorization).toBe("Bearer test-key");
    expect(captured?.body.model).toBe("deepseek-v4-flash");
    expect(Array.isArray(captured?.body.tools)).toBe(true);
    expect(JSON.stringify(captured?.body.tools)).toContain("test__run");
  });

  it("streams text deltas from chat completions SSE", async () => {
    const provider = new DeepSeekChatProvider({
      env: { DEEPSEEK_API_KEY: "test-key" },
      fetch: async () =>
        new Response(
          [
            'data: {"choices":[{"delta":{"content":"ne"}}]}',
            "",
            'data: {"choices":[{"delta":{"content":"xus"}}]}',
            "",
            "data: [DONE]",
            ""
          ].join("\n"),
          { status: 200 }
        )
    });

    const events = [];
    for await (const event of provider.stream({
      sessionId: "nx_test" as SessionId,
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "hello" }]
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "token", text: "ne" },
      { type: "token", text: "xus" },
      { type: "completed" }
    ]);
  });

  it("normalizes provider errors and marks rate limits retryable", async () => {
    const provider = new DeepSeekChatProvider({
      env: { DEEPSEEK_API_KEY: "test-key" },
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: { message: "rate limited sk-secret123456", code: "rate_limit" }
          }),
          {
            status: 429,
            headers: { "x-request-id": "req_1" }
          }
        )
    });

    await expect(
      provider.call({
        sessionId: "nx_test" as SessionId,
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: "hello" }]
      })
    ).rejects.toMatchObject({
      providerId: "deepseek",
      statusCode: 429,
      code: "rate_limit",
      retryable: true,
      message: "rate limited [REDACTED]"
    });
  });

  it.skipIf(!process.env.DEEPSEEK_API_KEY)(
    "completes a live DeepSeek smoke request",
    async () => {
      const provider = new DeepSeekChatProvider();
      const result = await provider.call({
        sessionId: "nx_live" as SessionId,
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: "Reply with exactly: nexus-live-ok" }]
      });

      expect(result.message.toLowerCase()).toContain("nexus-live-ok");
    },
    90000
  );
});
