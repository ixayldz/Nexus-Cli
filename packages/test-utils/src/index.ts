import {
  type ModelCallInput,
  type ModelCallResult,
  type ModelProvider,
  type ModelProviderCapabilities,
  type ModelStreamEvent
} from "@nexus/model-router";
import { type ToolCallId, createId } from "@nexus/shared";

export class FakeModelProvider implements ModelProvider {
  public readonly id = "fake";
  public readonly displayName = "Fake Model";
  public readonly capabilities: ModelProviderCapabilities = {
    supportsStreaming: true,
    supportsToolCalls: true,
    supportsImages: false,
    supportsReasoningSummaries: false
  };

  public async call(input: ModelCallInput): Promise<ModelCallResult> {
    if (input.observations && input.observations.length > 0) {
      return {
        message: summarizeObservations(input.observations),
        toolCalls: [],
        usage: { inputTokens: 20, outputTokens: 20 }
      };
    }

    const latestUserMessage = [...input.messages]
      .reverse()
      .find((message) => message.role === "user");
    const text = latestUserMessage?.content ?? "";
    if (/read\s+package\.json/i.test(text)) {
      return {
        message: "I need to inspect package.json before summarizing it.",
        toolCalls: [
          {
            id: createId("tool") as unknown as ToolCallId,
            name: "file.read",
            input: { path: "package.json" },
            reason: "The prompt explicitly asks to read package.json."
          }
        ],
        usage: { inputTokens: 10, outputTokens: 12 }
      };
    }

    if (/inspect repo|git status|safe command|search package scripts/i.test(text)) {
      return {
        message: "I will inspect the repository with safe runtime tools.",
        toolCalls: [
          {
            id: createId("tool") as unknown as ToolCallId,
            name: "git.status",
            input: {},
            reason: "Repository status is part of the requested inspection."
          },
          {
            id: createId("tool") as unknown as ToolCallId,
            name: "search.files",
            input: { query: "scripts", maxResults: 20 },
            reason: "Find package script references."
          },
          {
            id: createId("tool") as unknown as ToolCallId,
            name: "shell.run",
            input: { command: "node --version" },
            reason: "Run a low-risk command to verify shell execution."
          }
        ],
        usage: { inputTokens: 18, outputTokens: 20 }
      };
    }

    if (/high risk|dangerous|approval/i.test(text)) {
      return {
        message: "I will request a high-risk command to exercise policy handling.",
        toolCalls: [
          {
            id: createId("tool") as unknown as ToolCallId,
            name: "shell.run",
            input: { command: "rm -rf ." },
            reason: "Exercise approval-required flow."
          }
        ],
        usage: { inputTokens: 8, outputTokens: 8 }
      };
    }

    if (/write hello/i.test(text)) {
      return {
        message: "I will write a small hello module.",
        toolCalls: [
          {
            id: createId("tool") as unknown as ToolCallId,
            name: "file.write",
            input: {
              path: "src/hello.ts",
              content: 'export function hello(): string {\n  return "hello";\n}\n',
              createDirs: true
            },
            reason: "Exercise safe file mutation through Tool Bus."
          }
        ],
        usage: { inputTokens: 12, outputTokens: 12 }
      };
    }

    if (/apply patch/i.test(text)) {
      return {
        message: "I will apply a small patch.",
        toolCalls: [
          {
            id: createId("tool") as unknown as ToolCallId,
            name: "patch.apply",
            input: {
              patch: [
                "--- a/patch-target.txt",
                "+++ b/patch-target.txt",
                "@@ -1,1 +1,1 @@",
                "-old",
                "+new"
              ].join("\n")
            },
            reason: "Exercise patch application through Tool Bus."
          }
        ],
        usage: { inputTokens: 12, outputTokens: 12 }
      };
    }

    return {
      message: `Fake response: ${text}`,
      toolCalls: [],
      usage: { inputTokens: 8, outputTokens: 8 }
    };
  }

  public async *stream(input: ModelCallInput): AsyncIterable<ModelStreamEvent> {
    const result = await this.call(input);
    yield { type: "token", text: result.message };
    yield { type: "completed" };
  }
}

function summarizeObservations(observations: ModelCallInput["observations"]): string {
  const safeObservations = observations ?? [];
  const parts = safeObservations.map((observation) => {
    if (observation.toolName === "file.read") {
      return summarizeFileObservation(observation.output);
    }
    return `${observation.toolName}:${observation.status}${observation.summary ? ` (${observation.summary})` : ""}`;
  });
  return `Completed ${safeObservations.length} tool observation(s): ${parts.join("; ")}.`;
}

function summarizeFileObservation(output: unknown): string {
  if (!isFileReadOutput(output)) {
    return "The file read completed, but the output shape was not recognized.";
  }

  try {
    const parsed = JSON.parse(output.content) as {
      name?: unknown;
      version?: unknown;
      scripts?: unknown;
    };
    const name = typeof parsed.name === "string" ? parsed.name : "unknown";
    const version = typeof parsed.version === "string" ? parsed.version : "unknown";
    const scriptCount = isRecord(parsed.scripts) ? Object.keys(parsed.scripts).length : 0;
    return `package.json defines package '${name}' at version '${version}' with ${scriptCount} script(s).`;
  } catch {
    return `package.json was read successfully (${output.size} bytes).`;
  }
}

function isFileReadOutput(value: unknown): value is { content: string; size: number } {
  return isRecord(value) && typeof value.content === "string" && typeof value.size === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
