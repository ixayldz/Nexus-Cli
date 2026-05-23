import { type EventBus, createEvent } from "@nexus/events";
import { NexusError, type SessionId, type ToolCallId, redactString } from "@nexus/shared";

export interface ModelProviderCapabilities {
  supportsStreaming: boolean;
  supportsToolCalls: boolean;
  supportsImages: boolean;
  supportsReasoningSummaries: boolean;
  maxContextTokens?: number;
  maxOutputTokens?: number;
}

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

export interface ParsedToolCall {
  id: ToolCallId;
  name: string;
  input: unknown;
  reason?: string;
}

export interface ModelToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ModelObservation {
  toolCallId: ToolCallId;
  toolName: string;
  status: "success" | "failed" | "denied" | "cancelled";
  output?: unknown;
  summary?: string;
}

export interface ModelCallInput {
  sessionId: SessionId;
  model: string;
  messages: ModelMessage[];
  tools?: ModelToolDefinition[];
  context?: unknown;
  observations?: ModelObservation[];
}

export interface ModelCallResult {
  message: string;
  toolCalls: ParsedToolCall[];
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

export interface ModelStreamEvent {
  type: "token" | "completed";
  text?: string;
  usage?: ModelCallResult["usage"];
}

export interface ModelProvider {
  id: string;
  displayName: string;
  capabilities: ModelProviderCapabilities;
  call(input: ModelCallInput): Promise<ModelCallResult>;
  stream(input: ModelCallInput): AsyncIterable<ModelStreamEvent>;
}

export class ModelProviderError extends NexusError {
  public readonly providerId: string;
  public readonly statusCode?: number;
  public readonly code?: string;
  public readonly requestId?: string;
  public readonly retryable: boolean;

  public constructor(input: {
    providerId: string;
    message: string;
    statusCode?: number;
    code?: string;
    requestId?: string;
    retryable?: boolean;
  }) {
    super({
      category: "model",
      message: redactString(input.message),
      recoverable: input.retryable ?? false
    });
    this.providerId = input.providerId;
    if (input.statusCode !== undefined) {
      this.statusCode = input.statusCode;
    }
    if (input.code) {
      this.code = input.code;
    }
    if (input.requestId) {
      this.requestId = input.requestId;
    }
    this.retryable = input.retryable ?? false;
  }
}

export class ModelProviderRegistry {
  private readonly providers = new Map<string, ModelProvider>();

  public register(provider: ModelProvider): void {
    this.providers.set(provider.id, provider);
  }

  public get(providerId: string): ModelProvider | undefined {
    return this.providers.get(providerId);
  }
}

export interface RoutedModelCallInput extends ModelCallInput {
  providerId: string;
  eventBus: EventBus;
}

export interface ModelRouterPolicy {
  allowedProviders?: string[];
  allowedModels?: string[];
}

export class DefaultModelRouter {
  public constructor(
    private readonly registry: ModelProviderRegistry,
    private readonly policy: ModelRouterPolicy = {}
  ) {}

  public async call(input: RoutedModelCallInput): Promise<ModelCallResult> {
    this.assertAllowed(input);
    const provider = this.registry.get(input.providerId);
    if (!provider) {
      throw new ModelProviderError({
        providerId: input.providerId,
        message: `Model provider '${input.providerId}' is not registered.`,
        retryable: false
      });
    }

    await input.eventBus.publish(
      createEvent({
        sessionId: input.sessionId,
        type: "model.call.started",
        data: {
          provider: provider.id,
          model: input.model
        }
      })
    );

    const startedAt = Date.now();
    try {
      const result = await provider.call(input);

      await input.eventBus.publish(
        createEvent({
          sessionId: input.sessionId,
          type: "model.call.completed",
          data: {
            provider: provider.id,
            model: input.model,
            status: "success",
            toolCallCount: result.toolCalls.length,
            durationMs: Date.now() - startedAt,
            usage: result.usage ?? {}
          }
        })
      );
      if (result.usage) {
        await input.eventBus.publish(
          createEvent({
            sessionId: input.sessionId,
            type: "model.usage",
            data: {
              provider: provider.id,
              model: input.model,
              usage: result.usage
            }
          })
        );
      }

      return result;
    } catch (error) {
      const normalized = normalizeModelProviderError(provider.id, error);
      await input.eventBus.publish(
        createEvent({
          sessionId: input.sessionId,
          type: "model.call.failed",
          severity: "error",
          data: {
            provider: provider.id,
            model: input.model,
            statusCode: normalized.statusCode ?? 0,
            code: normalized.code ?? "",
            requestId: normalized.requestId ?? "",
            retryable: normalized.retryable,
            message: normalized.message
          }
        })
      );
      await input.eventBus.publish(
        createEvent({
          sessionId: input.sessionId,
          type: "model.call.completed",
          severity: "error",
          data: {
            provider: provider.id,
            model: input.model,
            status: "failed",
            statusCode: normalized.statusCode ?? 0,
            code: normalized.code ?? "",
            requestId: normalized.requestId ?? "",
            retryable: normalized.retryable,
            durationMs: Date.now() - startedAt,
            message: normalized.message
          }
        })
      );
      throw normalized;
    }
  }

  public async *stream(input: RoutedModelCallInput): AsyncIterable<ModelStreamEvent> {
    this.assertAllowed(input);
    const provider = this.registry.get(input.providerId);
    if (!provider) {
      throw new ModelProviderError({
        providerId: input.providerId,
        message: `Model provider '${input.providerId}' is not registered.`,
        retryable: false
      });
    }

    await input.eventBus.publish(
      createEvent({
        sessionId: input.sessionId,
        type: "model.stream.started",
        data: {
          provider: provider.id,
          model: input.model
        }
      })
    );

    const startedAt = Date.now();
    try {
      let outputTokens = 0;
      for await (const event of provider.stream(input)) {
        if (event.type === "token" && event.text) {
          outputTokens += 1;
          await input.eventBus.publish(
            createEvent({
              sessionId: input.sessionId,
              type: "model.stream.delta",
              data: {
                provider: provider.id,
                model: input.model,
                text: event.text
              }
            })
          );
          await input.eventBus.publish(
            createEvent({
              sessionId: input.sessionId,
              type: "assistant.delta",
              data: {
                text: event.text
              }
            })
          );
        }
        yield event;
      }

      await input.eventBus.publish(
        createEvent({
          sessionId: input.sessionId,
          type: "model.stream.completed",
          data: {
            provider: provider.id,
            model: input.model,
            status: "success",
            durationMs: Date.now() - startedAt,
            usage: { outputTokens }
          }
        })
      );
      await input.eventBus.publish(
        createEvent({
          sessionId: input.sessionId,
          type: "model.usage",
          data: {
            provider: provider.id,
            model: input.model,
            usage: { outputTokens }
          }
        })
      );
    } catch (error) {
      const normalized = normalizeModelProviderError(provider.id, error);
      await input.eventBus.publish(
        createEvent({
          sessionId: input.sessionId,
          type: "model.stream.completed",
          severity: "error",
          data: {
            provider: provider.id,
            model: input.model,
            status: "failed",
            statusCode: normalized.statusCode ?? 0,
            code: normalized.code ?? "",
            requestId: normalized.requestId ?? "",
            retryable: normalized.retryable,
            durationMs: Date.now() - startedAt,
            message: normalized.message
          }
        })
      );
      throw normalized;
    }
  }

  private assertAllowed(input: RoutedModelCallInput): void {
    const providers = this.policy.allowedProviders?.filter((item) => item.trim().length > 0) ?? [];
    if (providers.length > 0 && !providers.includes(input.providerId)) {
      throw new ModelProviderError({
        providerId: input.providerId,
        message: `Model provider '${input.providerId}' is denied by policy.`,
        retryable: false
      });
    }

    const models = this.policy.allowedModels?.filter((item) => item.trim().length > 0) ?? [];
    if (models.length > 0 && !models.includes(input.model)) {
      throw new ModelProviderError({
        providerId: input.providerId,
        message: `Model '${input.model}' is denied by policy.`,
        retryable: false
      });
    }
  }
}

export function normalizeModelProviderError(
  providerId: string,
  error: unknown
): ModelProviderError {
  if (error instanceof ModelProviderError) {
    return error;
  }

  if (error instanceof Error) {
    return new ModelProviderError({
      providerId,
      message: error.message,
      retryable: false
    });
  }

  return new ModelProviderError({
    providerId,
    message: String(error),
    retryable: false
  });
}

export function nexusToolDefinitions(): ModelToolDefinition[] {
  return [
    toolDefinition("file.read", "Read a UTF-8 file from the current workspace.", {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false
    }),
    toolDefinition("file.write", "Write a UTF-8 file inside the workspace.", {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        createDirs: { type: "boolean" }
      },
      required: ["path", "content"],
      additionalProperties: false
    }),
    toolDefinition("patch.apply", "Apply a unified diff inside the workspace.", {
      type: "object",
      properties: {
        patch: { type: "string" },
        dryRun: { type: "boolean" }
      },
      required: ["patch"],
      additionalProperties: false
    }),
    toolDefinition("shell.run", "Run an explicit shell command through policy controls.", {
      type: "object",
      properties: {
        command: { type: "string" },
        timeoutMs: { type: "integer" },
        maxOutputBytes: { type: "integer" }
      },
      required: ["command"],
      additionalProperties: false
    }),
    toolDefinition("git.status", "Read git branch and working tree status.", objectSchema()),
    toolDefinition("git.diff", "Read the current working tree diff.", objectSchema()),
    toolDefinition("git.log", "Read recent git commit log.", {
      type: "object",
      properties: { maxCount: { type: "integer" } },
      additionalProperties: false
    }),
    toolDefinition("test.run", "Run an explicit verification command.", {
      type: "object",
      properties: {
        command: { type: "string" },
        timeoutMs: { type: "integer" },
        maxOutputBytes: { type: "integer" }
      },
      required: ["command"],
      additionalProperties: false
    }),
    toolDefinition("search.files", "Search text files in the workspace.", {
      type: "object",
      properties: {
        query: { type: "string" },
        maxResults: { type: "integer" }
      },
      required: ["query"],
      additionalProperties: false
    }),
    toolDefinition("mcp.call", "Call an approved MCP server tool through the local MCP runtime.", {
      type: "object",
      properties: {
        serverId: { type: "string" },
        toolName: { type: "string" },
        arguments: { type: "object", additionalProperties: true }
      },
      required: ["serverId", "toolName"],
      additionalProperties: false
    })
  ];
}

function toolDefinition(
  name: string,
  description: string,
  parameters: Record<string, unknown>
): ModelToolDefinition {
  return { name, description, parameters };
}

function objectSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {},
    additionalProperties: false
  };
}
