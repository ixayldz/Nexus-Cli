import { access, realpath, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { type ResolvedConfig } from "@nexus/config";
import {
  type ApprovalPolicy,
  type ApprovalRequestId,
  type RiskLevel,
  type SandboxMode,
  type SessionId,
  createId,
  nowIso
} from "@nexus/shared";

export interface PolicyEvaluationInput {
  toolName: string;
  input: unknown;
  cwd: string;
  config: ResolvedConfig;
  nonInteractive: boolean;
  risk?: RiskLevel;
}

export interface PolicyDecision {
  decision: "allow" | "deny" | "needs_approval";
  reason: string;
  risk: RiskLevel;
  effectiveSandbox: SandboxMode;
}

export interface PathGuardResult {
  allowed: boolean;
  absolutePath: string;
  reason?: string;
  protected: boolean;
  relativePath: string;
}

export type CommandRiskCategory =
  | "destructive_filesystem"
  | "credential_access"
  | "network_exfiltration"
  | "download_and_execute"
  | "privilege_escalation"
  | "package_install"
  | "production_deploy"
  | "destructive_git"
  | "environment_dump"
  | "process_kill"
  | "system_mutation"
  | "local_executable";

export interface CommandRiskResult {
  risk: RiskLevel;
  categories: CommandRiskCategory[];
  reasons: string[];
  networkRisk?: RiskLevel;
}

export class SecurityRuntime {
  public async evaluateToolRequest(input: PolicyEvaluationInput): Promise<PolicyDecision> {
    if (input.toolName === "file.read") {
      return this.evaluateFileRead(input);
    }

    if (input.toolName === "file.write" || input.toolName === "patch.apply") {
      return this.evaluateMutation(input);
    }

    if (input.toolName === "shell.run") {
      return this.evaluateShell(input, readCommand(input.input));
    }

    if (input.toolName === "test.run") {
      return this.evaluateShell(input, readCommand(input.input), "medium");
    }

    if (
      input.toolName === "git.status" ||
      input.toolName === "git.diff" ||
      input.toolName === "git.log" ||
      input.toolName === "search.files"
    ) {
      return approvalAwareAllow(
        input,
        input.risk ?? "low",
        `${input.toolName} is allowed by policy.`
      );
    }

    if (input.toolName === "mcp.call") {
      return this.evaluateMcpCall(input);
    }

    return deny(input, `Tool '${input.toolName}' is not registered in policy.`, "medium");
  }

  public async guardPath(input: {
    cwd: string;
    path: string;
    config: ResolvedConfig;
    operation: "read" | "write";
    allowProtected?: boolean;
  }): Promise<PathGuardResult> {
    const workspaceRoot = resolve(input.cwd);
    const realWorkspaceRoot = await realpath(workspaceRoot).catch(() => workspaceRoot);
    const absolutePath = resolve(workspaceRoot, input.path);
    const insideWorkspace =
      absolutePath === workspaceRoot ||
      absolutePath.startsWith(
        workspaceRoot.endsWith(sep) ? workspaceRoot : `${workspaceRoot}${sep}`
      );
    const relativePath = relative(workspaceRoot, absolutePath).replaceAll("\\", "/");
    const protectedPath = isProtectedPath(relativePath, input.config.security.protectedPaths);

    if (!insideWorkspace) {
      return {
        allowed: false,
        absolutePath,
        reason: "Path escapes the workspace.",
        protected: protectedPath,
        relativePath
      };
    }

    const symlinkSafe = await isSymlinkSafe({
      realWorkspaceRoot,
      absolutePath,
      operation: input.operation
    });

    if (!symlinkSafe) {
      return {
        allowed: false,
        absolutePath,
        reason: "Path resolves outside the workspace through a symlink.",
        protected: protectedPath,
        relativePath
      };
    }

    if (protectedPath && !input.allowProtected) {
      return {
        allowed: false,
        absolutePath,
        reason: "Path is protected by security policy.",
        protected: true,
        relativePath
      };
    }

    return {
      allowed: true,
      absolutePath,
      protected: protectedPath,
      relativePath
    };
  }

  private async evaluateFileRead(input: PolicyEvaluationInput): Promise<PolicyDecision> {
    const filePath = readPath(input.input);
    if (!filePath) {
      return deny(input, "file.read requires a string path.", "low");
    }

    const pathDecision = await this.guardPath({
      cwd: input.cwd,
      path: filePath,
      config: input.config,
      operation: "read"
    });
    if (pathDecision.allowed) {
      return approvalAwareAllow(
        input,
        input.risk ?? "low",
        "Normal workspace file read is allowed."
      );
    }

    if (pathDecision.protected) {
      return approvalOrDeny(
        input,
        pathDecision.reason ?? "Protected path requires approval.",
        "high"
      );
    }

    return deny(input, pathDecision.reason ?? "Path denied by policy.", "medium");
  }

  private async evaluateMutation(input: PolicyEvaluationInput): Promise<PolicyDecision> {
    if (input.config.sandboxMode === "read-only") {
      return deny(input, "read-only sandbox denies filesystem mutations.", "medium");
    }

    const paths =
      input.toolName === "patch.apply"
        ? readPatchPaths(input.input)
        : [readPath(input.input)].filter((path): path is string => Boolean(path));
    if (paths.length === 0) {
      return deny(input, `${input.toolName} requires at least one target path.`, "medium");
    }

    for (const path of paths) {
      const pathDecision = await this.guardPath({
        cwd: input.cwd,
        path,
        config: input.config,
        operation: "write"
      });
      if (!pathDecision.allowed) {
        if (pathDecision.protected) {
          return approvalOrDeny(
            input,
            pathDecision.reason ?? "Protected path requires approval.",
            "high"
          );
        }
        return deny(input, pathDecision.reason ?? "Path denied by policy.", "medium");
      }
    }

    if (input.config.approvalPolicy === "always") {
      return approvalOrDeny(
        input,
        "Approval policy requires approval for mutating operations.",
        "medium"
      );
    }

    return approvalAwareAllow(
      input,
      input.risk ?? "medium",
      "Workspace mutation is allowed by policy."
    );
  }

  private evaluateShell(
    input: PolicyEvaluationInput,
    command: string | undefined,
    fallbackRisk?: RiskLevel
  ): PolicyDecision {
    if (!command) {
      return deny(input, `${input.toolName} requires a command.`, "medium");
    }

    const commandRisk = classifyCommand(command);
    const networkRisk = commandRisk.networkRisk;
    if (networkRisk && input.config.security.networkDefault === "off") {
      return deny(
        input,
        "Network access is disabled by security policy.",
        maxRisk(input.risk ?? "low", networkRisk)
      );
    }
    if (networkRisk && input.config.security.networkDefault === "restricted") {
      return approvalOrDeny(
        input,
        "Network access is restricted and requires approval.",
        maxRisk(input.risk ?? "medium", networkRisk)
      );
    }

    const risk = maxRisk(input.risk ?? commandRisk.risk, fallbackRisk ?? "low");
    if (risk === "high" || risk === "critical") {
      const details =
        commandRisk.categories.length > 0 ? ` (${commandRisk.categories.join(", ")})` : "";
      return approvalOrDeny(
        input,
        `Command risk is ${risk}${details}; approval is required.`,
        risk
      );
    }

    if (input.config.approvalPolicy === "always") {
      return approvalOrDeny(input, "Approval policy requires approval for shell execution.", risk);
    }

    return approvalAwareAllow(input, risk, "Shell command is allowed by policy.");
  }

  private evaluateMcpCall(input: PolicyEvaluationInput): PolicyDecision {
    if (!input.config.features.mcp) {
      return deny(input, "MCP execution is disabled by feature policy.", "medium");
    }
    const serverId = readStringField(input.input, "serverId");
    if (!serverId) {
      return deny(input, "mcp.call requires a serverId.", "medium");
    }
    const allowedServers = input.config.policy.allowedMcpServers.filter(
      (item) => item.trim().length > 0
    );
    if (allowedServers.length === 0 || !allowedServers.includes(serverId)) {
      return deny(input, `MCP server '${serverId}' is not allowlisted by policy.`, "high");
    }
    return approvalOrDeny(
      input,
      `MCP server '${serverId}' requires explicit approval.`,
      input.risk ?? "medium"
    );
  }
}

export type ApprovalDecisionValue = "approved" | "approved_for_session" | "denied";

export interface ApprovalRequestRecord {
  id: ApprovalRequestId;
  sessionId: SessionId;
  toolName: string;
  risk: RiskLevel;
  reason: string;
  fingerprint: string;
  createdAt: string;
  status: "pending" | ApprovalDecisionValue;
}

export interface ApprovalOutcome {
  id: ApprovalRequestId;
  decision: ApprovalDecisionValue;
}

export class ApprovalCoordinator {
  private readonly requests = new Map<ApprovalRequestId, ApprovalRequestRecord>();
  private readonly waiters = new Map<ApprovalRequestId, (outcome: ApprovalOutcome) => void>();
  private readonly sessionGrants = new Set<string>();

  public request(input: {
    sessionId: SessionId;
    toolName: string;
    risk: RiskLevel;
    reason: string;
    fingerprint: string;
  }): ApprovalRequestRecord {
    const id = createId("approval") as unknown as ApprovalRequestId;
    const record: ApprovalRequestRecord = {
      id,
      sessionId: input.sessionId,
      toolName: input.toolName,
      risk: input.risk,
      reason: input.reason,
      fingerprint: input.fingerprint,
      createdAt: nowIso(),
      status: "pending"
    };
    this.requests.set(id, record);
    return record;
  }

  public list(sessionId?: SessionId): ApprovalRequestRecord[] {
    return [...this.requests.values()].filter(
      (record) => !sessionId || record.sessionId === sessionId
    );
  }

  public latestPending(sessionId?: SessionId): ApprovalRequestRecord | undefined {
    return this.list(sessionId)
      .filter((record) => record.status === "pending")
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  }

  public hasSessionGrant(sessionId: SessionId, fingerprint: string): boolean {
    return this.sessionGrants.has(sessionGrantKey(sessionId, fingerprint));
  }

  public waitForDecision(id: ApprovalRequestId): Promise<ApprovalOutcome> {
    const existing = this.requests.get(id);
    if (!existing) {
      return Promise.resolve({ id, decision: "denied" });
    }
    if (existing.status !== "pending") {
      return Promise.resolve({ id, decision: existing.status });
    }
    return new Promise((resolveDecision) => {
      this.waiters.set(id, resolveDecision);
    });
  }

  public decide(id: ApprovalRequestId, decision: ApprovalDecisionValue): ApprovalOutcome {
    const record = this.requests.get(id);
    if (!record || record.status !== "pending") {
      return { id, decision: "denied" };
    }
    const updated: ApprovalRequestRecord = { ...record, status: decision };
    this.requests.set(id, updated);
    if (decision === "approved_for_session") {
      this.sessionGrants.add(sessionGrantKey(record.sessionId, record.fingerprint));
    }
    const outcome = { id, decision };
    const waiter = this.waiters.get(id);
    if (waiter) {
      this.waiters.delete(id);
      waiter(outcome);
    }
    return outcome;
  }
}

function sessionGrantKey(sessionId: SessionId, fingerprint: string): string {
  return `${sessionId}:${fingerprint}`;
}

export function classifyCommandRisk(command: string): RiskLevel {
  return classifyCommand(command).risk;
}

export function classifyCommand(command: string): CommandRiskResult {
  const categories = new Set<CommandRiskCategory>();
  const reasons: string[] = [];
  let risk: RiskLevel = "low";

  const add = (nextRisk: RiskLevel, category: CommandRiskCategory, reason: string): void => {
    risk = maxRisk(risk, nextRisk);
    categories.add(category);
    reasons.push(reason);
  };

  if (
    /\brm\s+-(?:[^\s]*r[^\s]*f|[^\s]*f[^\s]*r)\b/i.test(command) ||
    /\bRemove-Item\b.*\b-(?:Recurse|r)\b.*\b-(?:Force|f)\b/i.test(command)
  ) {
    add("critical", "destructive_filesystem", "recursive forced deletion");
  }
  if (/\b(del|erase|rd|rmdir)\b.*\b\/s\b/i.test(command)) {
    add("high", "destructive_filesystem", "recursive Windows deletion");
  }
  if (
    /\b(curl|wget|irm|iwr|Invoke-WebRequest|Invoke-RestMethod)\b[\s\S]*\|\s*(bash|sh|powershell|pwsh|cmd)\b/i.test(
      command
    )
  ) {
    add("critical", "download_and_execute", "downloaded content is piped to a shell");
  }
  if (/\bsudo\b|\bStart-Process\b.*\b-Verb\s+RunAs\b/i.test(command)) {
    add("high", "privilege_escalation", "privilege escalation");
  }
  if (/\b(printenv|env|set)\b(?:\s|$)|\bGet-ChildItem\s+Env:/i.test(command)) {
    add("high", "environment_dump", "environment variable dump");
  }
  if (/\b(cat|type|Get-Content)\b\s+(\.env|.*[/\\]\.env)\b/i.test(command)) {
    add("high", "credential_access", "dotenv credential read");
  }
  if (
    /\b(id_rsa|id_ed25519|\.npmrc|\.pypirc|credentials|kubeconfig|config\/gcloud)\b/i.test(command)
  ) {
    add("high", "credential_access", "credential file access");
  }
  if (/\b(git\s+reset|git\s+clean|git\s+push\s+--force|git\s+push\s+-f)\b/i.test(command)) {
    add("high", "destructive_git", "destructive git operation");
  }
  if (
    /\b(kubectl|aws|gcloud|az|terraform\s+apply|terraform\s+destroy|helm\s+upgrade|flyctl|vercel|netlify|wrangler)\b/i.test(
      command
    )
  ) {
    add("medium", "production_deploy", "deployment or cloud control command");
  }
  if (
    /\b(npm|pnpm|yarn)\s+(?:install|add|publish)|\bnpx\b|\bpip(?:3)?\s+install|\buv\s+pip\s+install|\bcargo\s+install|\bgo\s+install\b/i.test(
      command
    )
  ) {
    add("medium", "package_install", "package install or publish command");
  }
  if (/\b(chmod|chown)\s+-R\b|\bicacls\b|\bSet-Acl\b/i.test(command)) {
    add("medium", "system_mutation", "recursive permission or ownership mutation");
  }
  if (/\b(killall|taskkill|Stop-Process)\b/i.test(command)) {
    add("medium", "process_kill", "process termination command");
  }
  if (/(^|\s)(\.\/|\.\\|\/tmp\/|[A-Za-z]:\\)[^\s]+/i.test(command)) {
    add("high", "local_executable", "local executable launch");
  }

  const networkRisk = classifyNetworkUse(command);
  if (networkRisk) {
    add(networkRisk, "network_exfiltration", "network-capable command");
  }

  return {
    risk,
    categories: [...categories],
    reasons,
    ...(networkRisk ? { networkRisk } : {})
  };
}

export function classifyNetworkUse(command: string): RiskLevel | undefined {
  if (
    /\b(curl|wget|ssh|scp|sftp|git\s+clone|git\s+fetch|git\s+pull|npm\s+(install|publish)|pnpm\s+(install|add|publish)|yarn\s+(add|publish))\b/i.test(
      command
    )
  ) {
    return /\|\s*(bash|sh)\b/i.test(command) ? "critical" : "medium";
  }
  if (
    /\bnode(?:\.exe)?\s+-(?:e|p)\b/i.test(command) &&
    /\b(fetch|http|https|net|dns|WebSocket)\b/i.test(command)
  ) {
    return "medium";
  }
  if (
    /\bpowershell(?:\.exe)?\b/i.test(command) &&
    /\b(Invoke-WebRequest|Invoke-RestMethod|iwr|irm|WebClient|Start-BitsTransfer)\b/i.test(command)
  ) {
    return "medium";
  }
  if (
    /\bpython(?:3|\.exe)?\s+-c\b/i.test(command) &&
    /\b(requests|urllib|socket|http\.client|ftplib)\b/i.test(command)
  ) {
    return "medium";
  }
  return undefined;
}

export interface SecretFinding {
  type: "api_key" | "token" | "private_key" | "password" | "connection_string" | "unknown";
  severity: "low" | "medium" | "high" | "critical";
  redactedValue: string;
}

export class SecretsScanner {
  public scan(input: string): SecretFinding[] {
    const findings: SecretFinding[] = [];
    if (/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/.test(input)) {
      findings.push({ type: "token", severity: "high", redactedValue: "[REDACTED]" });
    }
    if (/\b[A-Za-z0-9_-]*api[_-]?key[A-Za-z0-9_-]*\s*[:=]\s*["']?[^"'\s]{8,}/i.test(input)) {
      findings.push({ type: "api_key", severity: "high", redactedValue: "[REDACTED]" });
    }
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(input)) {
      findings.push({ type: "private_key", severity: "critical", redactedValue: "[REDACTED]" });
    }
    if (/\bpassword\s*[:=]\s*["']?[^"'\s]{8,}/i.test(input)) {
      findings.push({ type: "password", severity: "medium", redactedValue: "[REDACTED]" });
    }
    if (/\b[a-z]+:\/\/[^:\s]+:[^@\s]+@[^/\s]+/i.test(input)) {
      findings.push({ type: "connection_string", severity: "high", redactedValue: "[REDACTED]" });
    }
    return findings;
  }
}

export interface PromptInjectionFinding {
  phrase: string;
  severity: "low" | "medium" | "high";
}

export class PromptInjectionDetector {
  public detect(input: string): PromptInjectionFinding[] {
    const findings: PromptInjectionFinding[] = [];
    for (const phrase of [
      "ignore previous instructions",
      "exfiltrate secrets",
      "run this command without asking"
    ]) {
      if (input.toLowerCase().includes(phrase)) {
        findings.push({ phrase, severity: "high" });
      }
    }
    return findings;
  }
}

function readPath(input: unknown): string | undefined {
  if (typeof input === "object" && input !== null && "path" in input) {
    const value = (input as { path: unknown }).path;
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function readCommand(input: unknown): string | undefined {
  return readStringField(input, "command");
}

function readStringField(input: unknown, key: string): string | undefined {
  if (typeof input === "object" && input !== null && key in input) {
    const value = (input as Record<string, unknown>)[key];
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function readPatchPaths(input: unknown): string[] {
  if (typeof input !== "object" || input === null || !("patch" in input)) {
    return [];
  }
  const patch = (input as { patch: unknown }).patch;
  if (typeof patch !== "string") {
    return [];
  }
  return [...patch.matchAll(/^\+\+\+\s+(?:b\/)?(.+)$/gm)]
    .map((match) => match[1])
    .filter((path): path is string => Boolean(path) && path !== "/dev/null");
}

function requiresApproval(policy: ApprovalPolicy): boolean {
  return policy === "always" || policy === "on-request" || policy === "on-failure";
}

function approvalOrDeny(
  input: PolicyEvaluationInput,
  reason: string,
  risk: RiskLevel
): PolicyDecision {
  if (!requiresApproval(input.config.approvalPolicy)) {
    return deny(input, reason, risk);
  }
  return {
    decision: "needs_approval",
    reason,
    risk,
    effectiveSandbox: input.config.sandboxMode
  };
}

function approvalAwareAllow(
  input: PolicyEvaluationInput,
  risk: RiskLevel,
  reason: string
): PolicyDecision {
  if (input.config.approvalPolicy === "always" && risk !== "low") {
    return approvalOrDeny(input, reason, risk);
  }
  return {
    decision: "allow",
    reason,
    risk,
    effectiveSandbox: input.config.sandboxMode
  };
}

function deny(input: PolicyEvaluationInput, reason: string, risk: RiskLevel): PolicyDecision {
  return {
    decision: "deny",
    reason,
    risk,
    effectiveSandbox: input.config.sandboxMode
  };
}

function isProtectedPath(filePath: string, protectedPaths: string[]): boolean {
  const normalized = filePath.replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  return protectedPaths.some((protectedPath) => {
    const protectedNormalized = protectedPath.replaceAll("\\", "/");
    if (protectedNormalized.endsWith(".*")) {
      const prefix = protectedNormalized.slice(0, -1);
      return segments.some((segment) => segment.startsWith(prefix));
    }
    return normalized === protectedNormalized || segments.includes(protectedNormalized);
  });
}

async function isSymlinkSafe(input: {
  realWorkspaceRoot: string;
  absolutePath: string;
  operation: "read" | "write";
}): Promise<boolean> {
  const realTarget = await realpath(input.absolutePath).catch(async () => {
    const parent = await findExistingParent(dirname(input.absolutePath));
    return parent ? await realpath(parent).catch(() => parent) : undefined;
  });

  if (!realTarget) {
    return false;
  }

  return (
    realTarget === input.realWorkspaceRoot ||
    realTarget.startsWith(
      input.realWorkspaceRoot.endsWith(sep)
        ? input.realWorkspaceRoot
        : `${input.realWorkspaceRoot}${sep}`
    )
  );
}

async function findExistingParent(path: string): Promise<string | undefined> {
  let current = resolve(path);
  while (dirname(current) !== current) {
    try {
      await access(current);
      const metadata = await stat(current);
      return metadata.isDirectory() ? current : dirname(current);
    } catch {
      current = dirname(current);
    }
  }
  return current;
}

function maxRisk(left: RiskLevel, right: RiskLevel): RiskLevel {
  const order: RiskLevel[] = ["low", "medium", "high", "critical"];
  return order.indexOf(left) >= order.indexOf(right) ? left : right;
}
