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
import {
  type ToolCallId,
  createId,
  redactString,
  safeJsonStringify
} from "@nexus/shared";

export interface OpenAiProviderOptions {
  config?: ProviderConfig;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
}

export interface OpenAiAuth {
  apiKey: string;
  organization?: string;
  project?: string;
  source: "environment" | "auth_file";
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class OpenAiResponsesProvider implements ModelProvider {
  public readonly id = "openai";
  public readonly displayName = "OpenAI";
  public readonly capabilities: ModelProviderCapabilities = {
    supportsStreaming: true,
    supportsToolCalls: true,
    supportsImages: true,
    supportsReasoningSummaries: true
  };

  private readonly config: ProviderConfig;
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: FetchLike;

  public constructor(input: OpenAiProviderOptions = {}) {
    this.config = input.config ?? {};
    this.cwd = input.cwd ?? process.cwd();
    this.env = input.env ?? process.env;
    this.fetchImpl = input.fetch ?? fetch;
  }

  public async call(input: ModelCallInput): Promise<ModelCallResult> {
    const auth = await loadOpenAiAuth({
      config: this.config,
      cwd: this.cwd,
      env: this.env
    });
    const response = await this.fetchImpl(this.responsesUrl(), {
      method: "POST",
      headers: this.headers(auth),
      body: safeJsonStringify({
        model: input.model,
        input: toOpenAiInput(input.messages, input.observations),
        tools: nexusToolSchemas(input.tools),
        tool_choice: "auto",
        store: false
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 60000)
    });

    if (!response.ok) {
      throw await toOpenAiError(this.id, response);
    }

    return normalizeOpenAiResponse(await response.json());
  }

  public async *stream(input: ModelCallInput): AsyncIterable<ModelStreamEvent> {
    const auth = await loadOpenAiAuth({
      config: this.config,
      cwd: this.cwd,
      env: this.env
    });
    const response = await this.fetchImpl(this.responsesUrl(), {
      method: "POST",
      headers: this.headers(auth),
      body: safeJsonStringify({
        model: input.model,
        input: toOpenAiInput(input.messages, input.observations),
        tools: nexusToolSchemas(input.tools),
        tool_choice: "auto",
        stream: true,
        store: false
      }),
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 60000)
    });

    if (!response.ok) {
      throw await toOpenAiError(this.id, response);
    }

    for await (const event of readSseEvents(response)) {
      if (event.type === "response.output_text.delta") {
        const text = readString(event, "delta") ?? readString(event, "text");
        if (text) {
          yield { type: "token", text };
        }
      }
      if (event.type === "response.completed") {
        yield { type: "completed" };
      }
      if (event.type === "error") {
        throw new ModelProviderError({
          providerId: this.id,
          message: readString(event, "message") ?? "OpenAI stream error.",
          retryable: false
        });
      }
    }
  }

  private responsesUrl(): string {
    const baseUrl = this.config.baseUrl ?? "https://api.openai.com/v1";
    return `${baseUrl.replace(/\/+$/, "")}/responses`;
  }

  private headers(auth: OpenAiAuth): HeadersInit {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${auth.apiKey}`,
      ...(auth.organization ? { "OpenAI-Organization": auth.organization } : {}),
      ...(auth.project ? { "OpenAI-Project": auth.project } : {})
    };
  }
}

export async function loadOpenAiAuth(input: {
  config?: ProviderConfig;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<OpenAiAuth> {
  const config = input.config ?? {};
  const env = input.env ?? process.env;
  const apiKeyEnv = config.apiKeyEnv ?? "OPENAI_API_KEY";
  const envApiKey = env[apiKeyEnv];
  if (envApiKey) {
    return {
      apiKey: envApiKey,
      source: "environment",
      ...(config.organization ? { organization: config.organization } : {}),
      ...(config.project ? { project: config.project } : {})
    };
  }

  const authFilePath = resolveAuthFilePath(config.authFile, input.cwd ?? process.cwd());
  const record = await readAuthRecord(authFilePath);
  if (record?.apiKey) {
    return {
      apiKey: record.apiKey,
      source: "auth_file",
      ...(config.organization ?? record.organization ? { organization: config.organization ?? record.organization } : {}),
      ...(config.project ?? record.project ? { project: config.project ?? record.project } : {})
    };
  }

  throw new ModelProviderError({
    providerId: "openai",
    message: `OpenAI API key was not found. Set ${apiKeyEnv} or configure an auth file.`,
    retryable: false
  });
}

export function normalizeOpenAiResponse(response: unknown): ModelCallResult {
  const output = readArray(response, "output");
  const message = readString(response, "output_text") ?? extractOutputText(output);
  const usage = normalizeUsage(readRecord(response, "usage"));
  return {
    message,
    toolCalls: normalizeOpenAiToolCalls(output),
    ...(usage ? { usage } : {})
  };
}

export function normalizeOpenAiToolCalls(output: unknown[]): ParsedToolCall[] {
  const toolCalls: ParsedToolCall[] = [];
  for (const item of output) {
    if (!isRecord(item)) {
      continue;
    }
    const type = readString(item, "type");
    if (type !== "function_call" && type !== "custom_tool_call") {
      continue;
    }
    const providerName = readString(item, "name");
    if (!providerName) {
      continue;
    }
    const callId = readString(item, "call_id") ?? readString(item, "id") ?? createId("tool");
    const args = readUnknown(item, "arguments") ?? readUnknown(item, "input") ?? "{}";
    toolCalls.push({
      id: callId as unknown as ToolCallId,
      name: fromOpenAiToolName(providerName),
      input: parseToolArguments(args)
    });
  }
  return toolCalls;
}

function toOpenAiInput(messages: ModelMessage[], observations: ModelCallInput["observations"]): unknown[] {
  const inputItems: unknown[] = messages.map((message) => ({
    role: message.role === "tool" ? "user" : message.role,
    content: message.content
  }));

  for (const observation of observations ?? []) {
    inputItems.push({
      role: "user",
      content: `Tool observation for ${observation.toolName} (${observation.status}): ${
        observation.summary ?? safeJsonStringify(observation.output ?? {})
      }`
    });
  }

  return inputItems;
}

function nexusToolSchemas(tools: ModelToolDefinition[] = nexusToolDefinitions()): unknown[] {
  return tools.map(toolSchema);
}

function toolSchema(definition: ModelToolDefinition): unknown {
  return {
    type: "function",
    name: toOpenAiToolName(definition.name),
    description: definition.description,
    parameters: definition.parameters
  };
}

function toOpenAiToolName(name: string): string {
  return name.replaceAll(".", "__");
}

function fromOpenAiToolName(name: string): string {
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

async function toOpenAiError(providerId: string, response: Response): Promise<ModelProviderError> {
  const requestId = response.headers.get("x-request-id") ?? undefined;
  const text = await response.text().catch(() => "");
  const payload = parseJsonObject(text);
  const error = readRecord(payload, "error") ?? payload;
  const message = readString(error, "message") ?? `OpenAI request failed with HTTP ${response.status}.`;
  const code = readString(error, "code") ?? readString(error, "type");
  return new ModelProviderError({
    providerId,
    message: redactString(message),
    statusCode: response.status,
    ...(code ? { code } : {}),
    ...(requestId ? { requestId } : {}),
    retryable: response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500
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

function extractOutputText(output: unknown[]): string {
  const parts: string[] = [];
  for (const item of output) {
    if (!isRecord(item) || readString(item, "type") !== "message") {
      continue;
    }
    for (const content of readArray(item, "content")) {
      if (!isRecord(content)) {
        continue;
      }
      const text = readString(content, "text");
      if (text) {
        parts.push(text);
      }
    }
  }
  return parts.join("");
}

function normalizeUsage(usage: Record<string, unknown> | undefined): ModelCallResult["usage"] | undefined {
  if (!usage) {
    return undefined;
  }
  const inputTokens = readNumber(usage, "input_tokens");
  const outputTokens = readNumber(usage, "output_tokens");
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

async function readAuthRecord(path: string): Promise<{ apiKey?: string; organization?: string; project?: string } | undefined> {
  const content = await readFile(path, "utf8").catch(() => undefined);
  if (!content) {
    return undefined;
  }
  const parsed = parseJsonObject(content);
  const direct = readRecord(parsed, "openai");
  const nested = readRecord(readRecord(parsed, "providers"), "openai");
  const record = nested ?? direct;
  if (!record) {
    return undefined;
  }
  const apiKey = readString(record, "apiKey") ?? readString(record, "api_key");
  const organization = readString(record, "organization");
  const project = readString(record, "project");
  return {
    ...(apiKey ? { apiKey } : {}),
    ...(organization ? { organization } : {}),
    ...(project ? { project } : {})
  };
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
