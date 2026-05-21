import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ModelProviderError } from "@nexus/model-router";
import { type SessionId } from "@nexus/shared";
import {
  OpenAiResponsesProvider,
  loadOpenAiAuth,
  normalizeOpenAiResponse,
  normalizeOpenAiToolCalls
} from "./index.js";

describe("OpenAiResponsesProvider", () => {
  it("loads auth from environment before auth file", async () => {
    const auth = await loadOpenAiAuth({
      config: { apiKeyEnv: "TEST_OPENAI_KEY" },
      env: { TEST_OPENAI_KEY: "sk-testenv123456" }
    });

    expect(auth).toMatchObject({ apiKey: "sk-testenv123456", source: "environment" });
  });

  it("loads auth from a local auth file", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "nexus-openai-"));
    try {
      await writeFile(
        join(cwd, "auth.json"),
        JSON.stringify({ providers: { openai: { apiKey: "sk-filekey123456", project: "proj_123" } } }),
        "utf8"
      );

      const auth = await loadOpenAiAuth({
        cwd,
        config: { authFile: "auth.json" },
        env: {}
      });

      expect(auth).toMatchObject({ apiKey: "sk-filekey123456", project: "proj_123", source: "auth_file" });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("normalizes response text, usage, and function tool calls", () => {
    const result = normalizeOpenAiResponse({
      output_text: "Need to read a file.",
      output: [
        {
          type: "function_call",
          call_id: "call_read",
          name: "file__read",
          arguments: "{\"path\":\"package.json\"}"
        }
      ],
      usage: { input_tokens: 12, output_tokens: 7 }
    });

    expect(result.message).toBe("Need to read a file.");
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 7 });
    expect(result.toolCalls).toMatchObject([{ id: "call_read", name: "file.read", input: { path: "package.json" } }]);
  });

  it("normalizes malformed tool arguments safely", () => {
    const calls = normalizeOpenAiToolCalls([
      {
        type: "function_call",
        call_id: "call_shell",
        name: "shell__run",
        arguments: "not-json"
      }
    ]);

    expect(calls).toMatchObject([{ name: "shell.run", input: { value: "not-json" } }]);
  });

  it("calls the Responses API without leaking API keys in errors", async () => {
    const provider = new OpenAiResponsesProvider({
      config: { apiKeyEnv: "TEST_OPENAI_KEY", baseUrl: "https://example.test/v1" },
      env: { TEST_OPENAI_KEY: "sk-secret123456" },
      fetch: async (_url, init) => {
        const headers = init.headers as Record<string, string>;
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(headers.authorization).toBe("Bearer sk-secret123456");
        expect(JSON.stringify(body.tools)).toContain("test__run");
        return new Response(
          JSON.stringify({ error: { message: "bad key sk-secret123456", code: "invalid_api_key" } }),
          { status: 401, headers: { "x-request-id": "req_123" } }
        );
      }
    });

    await expect(
      provider.call({
        sessionId: "nx_test" as SessionId,
        model: "gpt-5.5",
        messages: [{ role: "user", content: "hello" }]
      })
    ).rejects.toMatchObject({
      providerId: "openai",
      statusCode: 401,
      code: "invalid_api_key",
      requestId: "req_123",
      message: "bad key [REDACTED]"
    } satisfies Partial<ModelProviderError>);
  });

  it("streams text deltas from SSE", async () => {
    const provider = new OpenAiResponsesProvider({
      config: { apiKeyEnv: "TEST_OPENAI_KEY", baseUrl: "https://example.test/v1" },
      env: { TEST_OPENAI_KEY: "sk-stream123456" },
      fetch: async () =>
        new Response(
          [
            'data: {"type":"response.output_text.delta","delta":"hel"}',
            "",
            'data: {"type":"response.output_text.delta","delta":"lo"}',
            "",
            'data: {"type":"response.completed"}',
            ""
          ].join("\n"),
          { status: 200 }
        )
    });

    const events = [];
    for await (const event of provider.stream({
      sessionId: "nx_test" as SessionId,
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hello" }]
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "token", text: "hel" },
      { type: "token", text: "lo" },
      { type: "completed" }
    ]);
  });
});
