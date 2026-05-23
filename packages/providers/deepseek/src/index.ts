import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { type ProviderConfig } from "@nexus/config";
import {
  type ModelCallInput,
  type ModelCallResult,
  type ModelMessage,
  type ModelProvider,
  type ModelProviderCapabilities,
  type ModelToolDefinition,
  ModelProviderError,
  type ModelStreamEvent,
  type ParsedToolCall,
  nexusToolDefinitions
} from "@nexus/model-router";
import { type ToolCallId, createId, redactString, safeJsonStringify } from "@nexus/shared";

export interface DeepSeekProviderOptions {
  config?: ProviderConfig;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
}

export interface DeepSeekAuth {
  apiKey: string;
  source: "environment" | "auth_file";
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class DeepSeekChatProvider implements ModelProvider {
  public readonly id = "deepseek";
  public readonly displayName = "DeepSeek";
  public readonly capabilities: ModelProviderCapabilities = {
    supportsStreaming: true,
    supportsToolCalls: true,
    supportsImages: false,
    supportsReasoningSummaries: true
  };

  private readonly config: ProviderConfig;
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: FetchLike;

  public constructor(input: DeepSeekProviderOptions = {}) {
    this.config = input.config ?? {};
    this.cwd = input.cwd ?? process.cwd();
    this.env = input.env ?? process.env;
    this.fetchImpl = input.fetch ?? fetch;
  }

  public async call(input: ModelCallInput): Promise<ModelCallResult> {
    const auth = await loadDeepSeekAuth({ config: this.config, cwd: this.cwd, env: this.env });
    const response = await this.fetchImpl(this.chatCompletionsUrl(), {
      method: "POST",
      headers: this.headers(auth),
      body: safeJsonStringify({
        model: input.model,
        messages: toDeepSeekMessages(input.messages, input.observations),
        tools: nexusToolSchemas(input.tools),
        tool_choice: "auto",
        stream: false
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 60000)
    });

    if (!response.ok) {
      throw await toDeepSeekError(this.id, response);
    }

    return normalizeDeepSeekResponse(await response.json());
  }

  public async *stream(input: ModelCallInput): AsyncIterable<ModelStreamEvent> {
    const auth = await loadDeepSeekAuth({ config: this.config, cwd: this.cwd, env: this.env });
    const response = await this.fetchImpl(this.chatCompletionsUrl(), {
      method: "POST",
      headers: this.headers(auth),
      body: safeJsonStringify({
        model: input.model,
        messages: toDeepSeekMessages(input.messages, input.observations),
        tools: nexusToolSchemas(input.tools),
        tool_choice: "auto",
        stream: true
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 60000)
    });

    if (!response.ok) {
      throw await toDeepSeekError(this.id, response);
    }

    for await (const event of readSseEvents(response)) {
      const text = extractStreamDeltaText(event);
      if (text) {
        yield { type: "token", text };
      }
    }
    yield { type: "completed" };
  }

  private chatCompletionsUrl(): string {
    const baseUrl = this.config.baseUrl ?? "https://api.deepseek.com";
    return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  }

  private headers(auth: DeepSeekAuth): HeadersInit {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${auth.apiKey}`
    };
  }
}

export async function loadDeepSeekAuth(input: {
  config?: ProviderConfig;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<DeepSeekAuth> {
  const config = input.config ?? {};
  const env = input.env ?? process.env;
  const apiKeyEnv = config.apiKeyEnv ?? "DEEPSEEK_API_KEY";
  const envApiKey = env[apiKeyEnv];
  if (envApiKey) {
    return { apiKey: envApiKey, source: "environment" };
  }

  const authFilePath = resolveAuthFilePath(config.authFile, input.cwd ?? process.cwd());
  const record = await readAuthRecord(authFilePath);
  if (record?.apiKey) {
    return { apiKey: record.apiKey, source: "auth_file" };
  }

  throw new ModelProviderError({
    providerId: "deepseek",
    message: `DeepSeek API key was not found. Set ${apiKeyEnv} or configure an auth file.`,
    retryable: false
  });
}

export function normalizeDeepSeekResponse(response: unknown): ModelCallResult {
  const choice = readArray(response, "choices").find(isRecord);
  const message = readRecord(choice, "message");
  const content = readString(message, "content") ?? "";
  const usage = normalizeUsage(readRecord(response, "usage"));
  return {
    message: content,
    toolCalls: normalizeDeepSeekToolCalls(readArray(message, "tool_calls")),
    ...(usage ? { usage } : {})
  };
}

export function normalizeDeepSeekToolCalls(output: unknown[]): ParsedToolCall[] {
  const toolCalls: ParsedToolCall[] = [];
  for (const item of output) {
    if (!isRecord(item)) {
      continue;
    }
    const callId = readString(item, "id") ?? createId("tool");
    const fn = readRecord(item, "function");
    const providerName = readString(fn, "name");
    if (!providerName) {
      continue;
    }
    toolCalls.push({
      id: callId as unknown as ToolCallId,
      name: fromProviderToolName(providerName),
      input: parseToolArguments(readUnknown(fn, "arguments"))
    });
  }
  return toolCalls;
}

function toDeepSeekMessages(
  messages: ModelMessage[],
  observations: ModelCallInput["observations"]
): unknown[] {
  const result: unknown[] = messages.map((message) => ({
    role: message.role === "tool" ? "user" : message.role,
    content: message.content
  }));

  for (const observation of observations ?? []) {
    result.push({
      role: "user",
      content: `Tool observation for ${observation.toolName} (${observation.status}): ${
        observation.summary ?? safeJsonStringify(observation.output ?? {})
      }`
    });
  }

  return result;
}

function nexusToolSchemas(tools: ModelToolDefinition[] = nexusToolDefinitions()): unknown[] {
  return tools.map(toolSchema);
}

function toolSchema(definition: ModelToolDefinition): unknown {
  return {
    type: "function",
    function: {
      name: toProviderToolName(definition.name),
      description: definition.description,
      parameters: definition.parameters
    }
  };
}

function toProviderToolName(name: string): string {
  return name.replaceAll(".", "__");
}

function fromProviderToolName(name: string): string {
  return name.replaceAll("__", ".");
}

function parseToolArguments(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.trim().length === 0) {
      return {};
    }
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return { value };
    }
  }
  return value ?? {};
}

async function toDeepSeekError(
  providerId: string,
  response: Response
): Promise<ModelProviderError> {
  const requestId =
    response.headers.get("x-request-id") ?? response.headers.get("x-ds-request-id") ?? undefined;
  const text = await response.text().catch(() => "");
  const payload = parseJsonObject(text);
  const error = readRecord(payload, "error") ?? payload;
  const message =
    readString(error, "message") ?? `DeepSeek request failed with HTTP ${response.status}.`;
  const code = readString(error, "code") ?? readString(error, "type");
  return new ModelProviderError({
    providerId,
    message: redactString(message),
    statusCode: response.status,
    ...(code ? { code } : {}),
    ...(requestId ? { requestId } : {}),
    retryable:
      response.status === 408 ||
      response.status === 409 ||
      response.status === 429 ||
      response.status >= 500
  });
}

async function* readSseEvents(response: Response): AsyncIterable<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) {
    return;
  }

  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const event = parseSseBlock(block);
      if (event) {
        yield event;
      }
    }
  }

  const trailing = parseSseBlock(buffer);
  if (trailing) {
    yield trailing;
  }
}

function parseSseBlock(block: string): Record<string, unknown> | undefined {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") {
    return undefined;
  }
  return parseJsonObject(data);
}

function extractStreamDeltaText(event: Record<string, unknown>): string | undefined {
  const choice = readArray(event, "choices").find(isRecord);
  const delta = readRecord(choice, "delta");
  return readString(delta, "content") ?? undefined;
}

function normalizeUsage(
  usage: Record<string, unknown> | undefined
): ModelCallResult["usage"] | undefined {
  if (!usage) {
    return undefined;
  }
  const inputTokens = readNumber(usage, "prompt_tokens");
  const outputTokens = readNumber(usage, "completion_tokens");
  if (inputTokens === undefined && outputTokens === undefined) {
    return undefined;
  }
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {})
  };
}

function resolveAuthFilePath(authFile: string | undefined, cwd: string): string {
  if (authFile) {
    return isAbsolute(authFile) ? authFile : resolve(cwd, authFile);
  }
  return join(homedir(), ".nexus", "auth.json");
}

async function readAuthRecord(path: string): Promise<{ apiKey?: string } | undefined> {
  const content = await readFile(path, "utf8").catch(() => undefined);
  if (!content) {
    return undefined;
  }
  const parsed = parseJsonObject(content);
  const direct = readRecord(parsed, "deepseek");
  const nested = readRecord(readRecord(parsed, "providers"), "deepseek");
  const record = nested ?? direct;
  if (!record) {
    return undefined;
  }
  const apiKey = readString(record, "apiKey") ?? readString(record, "api_key");
  return apiKey ? { apiKey } : {};
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readRecord(source: unknown, key?: string): Record<string, unknown> | undefined {
  const value = key === undefined ? source : isRecord(source) ? source[key] : undefined;
  return isRecord(value) ? value : undefined;
}

function readArray(source: unknown, key: string): unknown[] {
  if (!isRecord(source)) {
    return [];
  }
  const value = source[key];
  return Array.isArray(value) ? value : [];
}

function readUnknown(source: unknown, key: string): unknown {
  return isRecord(source) ? source[key] : undefined;
}

function readString(source: unknown, key: string): string | undefined {
  const value = readUnknown(source, key);
  return typeof value === "string" ? value : undefined;
}

function readNumber(source: unknown, key: string): number | undefined {
  const value = readUnknown(source, key);
  return typeof value === "number" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
