#!/usr/bin/env node

import { join } from "node:path";
import { DeepSeekChatProvider } from "@nexus/provider-deepseek";
import { OpenAiResponsesProvider } from "@nexus/provider-openai";
import { type SessionId, nowIso, safeJsonStringify } from "@nexus/shared";
import { safeAtomicWriteText } from "@nexus/storage";

type ProviderId = "deepseek" | "openai";
type ProviderSelection = ProviderId | "all";

interface ProviderSmokeResult {
  provider: ProviderId;
  model: string;
  status: "passed" | "failed" | "skipped";
  summary: string;
  callMessage?: string;
  streamTokenCount?: number;
  createdAt: string;
}

interface ProviderSmokeOptions {
  provider: ProviderSelection;
  model?: string;
  requireLive: boolean;
}

const options = readOptions(process.argv.slice(2));
const results = await Promise.all(
  expandProviders(options.provider).map((provider) =>
    runProviderSmoke(provider, options.model ?? defaultModel(provider), options.requireLive)
  )
);
await Promise.all(results.map((result) => writeProviderSmokeResult(process.cwd(), result)));

for (const result of results) {
  const prefix = `${result.status}: ${result.summary}`;
  if (result.status === "failed") {
    process.stderr.write(`${prefix}\n`);
  } else {
    process.stdout.write(`${prefix}\n`);
  }
}

if (results.some((result) => result.status === "failed")) {
  process.exitCode = 1;
}

async function runProviderSmoke(
  providerId: ProviderId,
  model: string,
  requireLive: boolean
): Promise<ProviderSmokeResult> {
  const createdAt = nowIso();
  const keyName = providerId === "deepseek" ? "DEEPSEEK_API_KEY" : "OPENAI_API_KEY";
  if (!process.env[keyName]) {
    return {
      provider: providerId,
      model,
      status: requireLive ? "failed" : "skipped",
      summary: `${keyName} is not set.`,
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
  await safeAtomicWriteText({
    path: join(directory, "latest.json"),
    allowedRoot: join(cwd, ".nexus"),
    workspaceRoot: cwd,
    content: `${safeJsonStringify(result)}\n`,
    rootDescription: ".nexus provider smoke storage"
  });
}

function readOptions(args: string[]): ProviderSmokeOptions {
  const model = readFlag(args, "--model");
  return {
    provider: readProvider(args),
    ...(model ? { model } : {}),
    requireLive: args.includes("--require-live")
  };
}

function readProvider(args: string[]): ProviderSelection {
  const value = readFlag(args, "--provider");
  if (!value) {
    return "deepseek";
  }
  if (value === "deepseek" || value === "openai" || value === "all") {
    return value;
  }
  throw new Error(`Unsupported provider '${value}'.`);
}

function readFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function expandProviders(provider: ProviderSelection): ProviderId[] {
  return provider === "all" ? ["deepseek", "openai"] : [provider];
}

function defaultModel(provider: ProviderId): string {
  return provider === "deepseek" ? "deepseek-v4-flash" : "gpt-5.4-mini";
}
