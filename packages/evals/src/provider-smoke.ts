#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DeepSeekChatProvider } from "@nexus/provider-deepseek";
import { OpenAiResponsesProvider } from "@nexus/provider-openai";
import { type SessionId, nowIso, safeJsonStringify } from "@nexus/shared";

type ProviderId = "deepseek" | "openai";

interface ProviderSmokeResult {
  provider: ProviderId;
  model: string;
  status: "passed" | "failed" | "skipped";
  summary: string;
  callMessage?: string;
  streamTokenCount?: number;
  createdAt: string;
}

const provider = readProvider(process.argv.slice(2));
const model = readModel(process.argv.slice(2), provider);
const result = await runProviderSmoke(provider, model);
await writeProviderSmokeResult(process.cwd(), result);

if (result.status === "failed") {
  process.stderr.write(`${result.summary}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${result.status}: ${result.summary}\n`);
}

async function runProviderSmoke(
  providerId: ProviderId,
  model: string
): Promise<ProviderSmokeResult> {
  const createdAt = nowIso();
  if (providerId === "deepseek" && !process.env.DEEPSEEK_API_KEY) {
    return {
      provider: providerId,
      model,
      status: "skipped",
      summary: "DEEPSEEK_API_KEY is not set.",
      createdAt
    };
  }
  if (providerId === "openai" && !process.env.OPENAI_API_KEY) {
    return {
      provider: providerId,
      model,
      status: "skipped",
      summary: "OPENAI_API_KEY is not set.",
      createdAt
    };
  }

  const providerInstance =
    providerId === "deepseek"
      ? new DeepSeekChatProvider()
      : new OpenAiResponsesProvider({ config: { timeoutMs: 60000 }, cwd: process.cwd() });
  try {
    const call = await providerInstance.call({
      sessionId: "nx_provider_smoke" as SessionId,
      model,
      messages: [{ role: "user", content: "Reply with exactly: nexus-live-ok" }],
      tools: []
    });
    let streamTokenCount = 0;
    for await (const event of providerInstance.stream({
      sessionId: "nx_provider_smoke" as SessionId,
      model,
      messages: [{ role: "user", content: "Reply with exactly: ok" }],
      tools: []
    })) {
      if (event.type === "token" && event.text) {
        streamTokenCount += 1;
      }
    }
    const passed = call.message.toLowerCase().includes("nexus-live-ok") && streamTokenCount > 0;
    return {
      provider: providerId,
      model,
      status: passed ? "passed" : "failed",
      summary: passed
        ? `${providerId} call and stream smoke passed.`
        : `${providerId} smoke returned unexpected output.`,
      callMessage: call.message.slice(0, 200),
      streamTokenCount,
      createdAt
    };
  } catch (error) {
    return {
      provider: providerId,
      model,
      status: "failed",
      summary: error instanceof Error ? error.message : String(error),
      createdAt
    };
  }
}

async function writeProviderSmokeResult(cwd: string, result: ProviderSmokeResult): Promise<void> {
  const directory = join(cwd, ".nexus", "provider-smoke", result.provider);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "latest.json"), `${safeJsonStringify(result)}\n`, "utf8");
}

function readProvider(args: string[]): ProviderId {
  const index = args.indexOf("--provider");
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) {
    return "deepseek";
  }
  if (value === "deepseek" || value === "openai") {
    return value;
  }
  throw new Error(`Unsupported provider '${value}'.`);
}

function readModel(args: string[], provider: ProviderId): string {
  const index = args.indexOf("--model");
  const value = index >= 0 ? args[index + 1] : undefined;
  if (value) {
    return value;
  }
  return provider === "deepseek" ? "deepseek-v4-flash" : "gpt-5.4-mini";
}
