import { randomUUID } from "node:crypto";

export type Brand<T, B extends string> = T & { readonly __brand: B };

export type SessionId = Brand<string, "SessionId">;
export type ThreadId = Brand<string, "ThreadId">;
export type EventId = Brand<string, "EventId">;
export type ToolCallId = Brand<string, "ToolCallId">;
export type ApprovalRequestId = Brand<string, "ApprovalRequestId">;
export type PlanId = Brand<string, "PlanId">;
export type MemoryId = Brand<string, "MemoryId">;
export type LearningCandidateId = Brand<string, "LearningCandidateId">;
export type SubagentId = Brand<string, "SubagentId">;

export type ApprovalPolicy = "always" | "on-request" | "on-failure" | "never";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type LearningMode = "off" | "observe" | "suggest" | "active";
export type RiskLevel = "low" | "medium" | "high" | "critical";

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

let idCounterForTests: number | undefined;
let nowForTests: string | undefined;

export function setIdCounterForTests(value: number | undefined): void {
  idCounterForTests = value;
}

export function setNowForTests(value: string | undefined): void {
  nowForTests = value;
}

export function createId<TPrefix extends string>(prefix: TPrefix): Brand<string, TPrefix> {
  if (idCounterForTests !== undefined) {
    const id = `${prefix}_${String(idCounterForTests).padStart(4, "0")}`;
    idCounterForTests += 1;
    return id as Brand<string, TPrefix>;
  }

  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}` as Brand<string, TPrefix>;
}

export function nowIso(): string {
  return nowForTests ?? new Date().toISOString();
}

export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${String(value)}`);
}

const secretPatterns: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/g,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\b[A-Za-z0-9_-]*api[_-]?key[A-Za-z0-9_-]*\s*[:=]\s*["']?[^"'\s]{8,}/gi,
  /\b[A-Za-z0-9_-]*token[A-Za-z0-9_-]*\s*[:=]\s*["']?[^"'\s]{8,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
];

export function redactString(input: string): string {
  return secretPatterns.reduce((text, pattern) => text.replace(pattern, "[REDACTED]"), input);
}

export function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, nestedValue: unknown) => {
    if (typeof nestedValue === "string") {
      return redactString(nestedValue);
    }

    if (typeof nestedValue === "object" && nestedValue !== null) {
      if (seen.has(nestedValue)) {
        return "[Circular]";
      }
      seen.add(nestedValue);
    }

    return nestedValue;
  });
}

export class NexusError extends Error {
  public readonly category: NexusErrorCategory;
  public readonly recoverable: boolean;

  public constructor(input: {
    category: NexusErrorCategory;
    message: string;
    recoverable?: boolean;
  }) {
    super(input.message);
    this.name = "NexusError";
    this.category = input.category;
    this.recoverable = input.recoverable ?? false;
  }
}

export type NexusErrorCategory =
  | "config"
  | "auth"
  | "model"
  | "tool"
  | "sandbox"
  | "approval"
  | "security"
  | "storage"
  | "tui"
  | "network"
  | "unknown";
