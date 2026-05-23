import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";
import {
  type ApprovalPolicy,
  type LearningMode,
  NexusError,
  type SandboxMode
} from "@nexus/shared";

export interface FeatureFlags {
  agenticSdlc: boolean;
  learningPlane: boolean;
  subagents: boolean;
  mcp: boolean;
  skills: boolean;
  hooks: boolean;
  plugins: boolean;
}

export interface LearningConfig {
  mode: LearningMode;
  redactSecrets: boolean;
  requireUserConfirmation: boolean;
}

export interface SdlcConfig {
  requirePlanForLargeChanges: boolean;
  requireVerification: boolean;
  requireReviewForSecuritySensitiveChanges: boolean;
}

export type AgentCriticMode = "off" | "after_mutation" | "always";

export interface AgentConfig {
  maxModelTurns: number;
  maxToolCalls: number;
  maxRepeatedToolCalls: number;
  maxSubagents: number;
  criticMode: AgentCriticMode;
  maxObservationChars: number;
}

export interface SecurityConfig {
  networkDefault: "off" | "on" | "restricted";
  protectedPaths: string[];
  secretsScanning: boolean;
  promptInjectionDetection: boolean;
  requireHardSandbox: boolean;
}

export interface SandboxConfig {
  preferredAdapter: "auto" | "typescript" | "docker" | "podman";
  containerRuntime: "auto" | "docker" | "podman";
  containerImage: string;
  containerNetwork: "none" | "host";
  envAllowlist: string[];
  timeoutMs: number;
  memoryLimitMb?: number;
  cpuLimit?: number;
}

export interface PolicyConfig {
  allowedProviders: string[];
  allowedModels: string[];
  allowedMcpServers: string[];
}

export interface RetentionConfig {
  localLogsDays: number;
  eventLogsDays: number;
  memoryRetention: "until_deleted";
  cloudSync: boolean;
}

export interface TelemetryConfig {
  operationalMetrics: boolean;
  productAnalytics: boolean;
  contentTelemetry: boolean;
  crashReports: boolean;
  enterpriseAudit: boolean;
}

export interface TuiConfig {
  statusLineItems: string[];
}

export interface ProviderConfig {
  apiKeyEnv?: string;
  baseUrl?: string;
  authFile?: string;
  organization?: string;
  project?: string;
  timeoutMs?: number;
}

export type ProviderConfigMap = Record<string, ProviderConfig>;

export interface ResolvedConfig {
  model: string;
  modelProvider: string;
  approvalPolicy: ApprovalPolicy;
  sandboxMode: SandboxMode;
  selectedProfile?: string;
  features: FeatureFlags;
  learning: LearningConfig;
  sdlc: SdlcConfig;
  agent: AgentConfig;
  security: SecurityConfig;
  sandbox: SandboxConfig;
  policy: PolicyConfig;
  retention: RetentionConfig;
  telemetry: TelemetryConfig;
  tui: TuiConfig;
  providers: ProviderConfigMap;
  sources: ConfigSource[];
}

export interface ConfigSource {
  path: string;
  loaded: boolean;
  reason?: string;
}

export interface ConfigOverrides {
  model?: string;
  modelProvider?: string;
  approvalPolicy?: ApprovalPolicy;
  sandboxMode?: SandboxMode;
  profile?: string;
}

export interface ResolveConfigInput {
  cwd: string;
  configPath?: string;
  overrides?: ConfigOverrides;
}

type PartialConfig = Record<string, unknown>;

const approvalPolicySchema = z.enum(["always", "on-request", "on-failure", "never"]);
const sandboxModeSchema = z.enum(["read-only", "workspace-write", "danger-full-access"]);
const learningModeSchema = z.enum(["off", "observe", "suggest", "active"]);

const rawConfigSchema = z.object({}).passthrough();
const builtInProfiles: Record<string, PartialConfig> = {
  safe: {
    sandbox_mode: "read-only",
    approval_policy: "on-request",
    security: { network_default: "off" }
  },
  workspace: {
    sandbox_mode: "workspace-write",
    approval_policy: "on-request",
    security: { network_default: "off" }
  },
  automation: {
    sandbox_mode: "workspace-write",
    approval_policy: "never",
    security: { network_default: "off" }
  },
  fake: {
    model: "fake-default",
    model_provider: "fake",
    sandbox_mode: "workspace-write",
    approval_policy: "never"
  },
  deepseek: {
    model: "deepseek-v4-flash",
    model_provider: "deepseek"
  }
};

export const defaultConfig: Omit<ResolvedConfig, "sources" | "selectedProfile"> = {
  model: "deepseek-v4-flash",
  modelProvider: "deepseek",
  approvalPolicy: "on-request",
  sandboxMode: "read-only",
  features: {
    agenticSdlc: true,
    learningPlane: true,
    subagents: false,
    mcp: false,
    skills: false,
    hooks: false,
    plugins: false
  },
  learning: {
    mode: "suggest",
    redactSecrets: true,
    requireUserConfirmation: true
  },
  sdlc: {
    requirePlanForLargeChanges: true,
    requireVerification: true,
    requireReviewForSecuritySensitiveChanges: true
  },
  agent: {
    maxModelTurns: 12,
    maxToolCalls: 40,
    maxRepeatedToolCalls: 2,
    maxSubagents: 3,
    criticMode: "after_mutation",
    maxObservationChars: 12000
  },
  security: {
    networkDefault: "off",
    protectedPaths: [
      ".env",
      ".env.*",
      ".ssh",
      ".aws",
      ".gcp",
      ".azure",
      ".git",
      "node_modules",
      "dist",
      "build"
    ],
    secretsScanning: true,
    promptInjectionDetection: true,
    requireHardSandbox: false
  },
  sandbox: {
    preferredAdapter: "auto",
    containerRuntime: "auto",
    containerImage: "node:22-bookworm-slim",
    containerNetwork: "none",
    envAllowlist: ["PATH", "HOME", "USERPROFILE", "TMP", "TEMP", "PNPM_HOME"],
    timeoutMs: 300000
  },
  policy: {
    allowedProviders: [],
    allowedModels: [],
    allowedMcpServers: []
  },
  retention: {
    localLogsDays: 30,
    eventLogsDays: 30,
    memoryRetention: "until_deleted",
    cloudSync: false
  },
  telemetry: {
    operationalMetrics: false,
    productAnalytics: false,
    contentTelemetry: false,
    crashReports: false,
    enterpriseAudit: true
  },
  tui: {
    statusLineItems: [
      "model",
      "sandbox",
      "approval",
      "git_branch",
      "tokens",
      "sdlc_stage",
      "learning_mode"
    ]
  },
  providers: {
    fake: {},
    openai: {
      apiKeyEnv: "OPENAI_API_KEY",
      baseUrl: "https://api.openai.com/v1",
      timeoutMs: 60000
    },
    deepseek: {
      apiKeyEnv: "DEEPSEEK_API_KEY",
      baseUrl: "https://api.deepseek.com",
      timeoutMs: 60000
    }
  }
};

export async function resolveConfig(input: ResolveConfigInput): Promise<ResolvedConfig> {
  const cwd = resolve(input.cwd);
  const sources: ConfigSource[] = [];
  const systemConfig = "/etc/nexus/config.toml";
  const userConfig = join(homedir(), ".nexus", "config.toml");
  const projectConfig = await findProjectConfigPath(cwd);
  const explicitConfig = input.configPath
    ? isAbsolute(input.configPath)
      ? input.configPath
      : resolve(cwd, input.configPath)
    : undefined;

  let merged: PartialConfig = normalizeResolved(defaultConfig);

  for (const configPath of [systemConfig, userConfig, projectConfig].filter(
    (value): value is string => Boolean(value)
  )) {
    const loaded = await loadConfigFile(configPath, sources);
    merged = mergeDeep(merged, loaded);
  }

  const selectedProfile = input.overrides?.profile ?? readString(merged, "profile");
  if (selectedProfile) {
    const profiles = readRecord(merged, "profiles");
    const profileConfig = readRecord(profiles, selectedProfile) ?? builtInProfiles[selectedProfile];
    if (!profileConfig) {
      throw new NexusError({
        category: "config",
        message: `Profile '${selectedProfile}' was selected but not found in config.`,
        recoverable: true
      });
    }
    merged = mergeDeep(merged, profileConfig);
  }

  if (explicitConfig) {
    const loaded = await loadConfigFile(explicitConfig, sources);
    merged = mergeDeep(merged, loaded);
  }

  merged = applyOverrides(merged, input.overrides);

  return normalizeAndValidate(merged, sources, selectedProfile);
}

async function findProjectConfigPath(cwd: string): Promise<string> {
  let current = cwd;
  while (true) {
    const candidate = join(current, ".nexus", "config.toml");
    try {
      await access(candidate);
      return candidate;
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        return join(cwd, ".nexus", "config.toml");
      }
      current = parent;
    }
  }
}

async function loadConfigFile(filePath: string, sources: ConfigSource[]): Promise<PartialConfig> {
  try {
    await access(filePath);
  } catch {
    sources.push({ path: filePath, loaded: false, reason: "missing" });
    return {};
  }

  try {
    const parsed = parse(stripBom(await readFile(filePath, "utf8")));
    const value = rawConfigSchema.parse(parsed);
    sources.push({ path: filePath, loaded: true });
    return value;
  } catch (error) {
    throw new NexusError({
      category: "config",
      message: `Invalid config at ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      recoverable: true
    });
  }
}

function stripBom(content: string): string {
  return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

function applyOverrides(
  config: PartialConfig,
  overrides: ConfigOverrides | undefined
): PartialConfig {
  if (!overrides) {
    return config;
  }

  return mergeDeep(config, {
    ...(overrides.model ? { model: overrides.model } : {}),
    ...(overrides.modelProvider ? { model_provider: overrides.modelProvider } : {}),
    ...(overrides.approvalPolicy ? { approval_policy: overrides.approvalPolicy } : {}),
    ...(overrides.sandboxMode ? { sandbox_mode: overrides.sandboxMode } : {})
  });
}

function normalizeAndValidate(
  config: PartialConfig,
  sources: ConfigSource[],
  selectedProfile: string | undefined
): ResolvedConfig {
  const approvalPolicy = approvalPolicySchema.parse(
    readString(config, "approval_policy") ?? "on-request"
  );
  const sandboxMode = sandboxModeSchema.parse(
    readString(config, "sandbox_mode") ?? "workspace-write"
  );
  const learning = readRecord(config, "learning") ?? {};
  const features = readRecord(config, "features") ?? {};
  const sdlc = readRecord(config, "sdlc") ?? {};
  const agent = readRecord(config, "agent") ?? {};
  const security = readRecord(config, "security") ?? {};
  const sandbox = readRecord(config, "sandbox") ?? {};
  const policy = readRecord(config, "policy") ?? {};
  const retention = readRecord(config, "retention") ?? {};
  const telemetry = readRecord(config, "telemetry") ?? {};
  const tui = readRecord(config, "tui") ?? {};
  const providers = readRecord(config, "providers") ?? {};
  const tuiStatusLine = readRecord(tui, "status_line") ?? {};
  const sandboxMemoryLimitMb = readNumber(sandbox, "memory_limit_mb");
  const sandboxCpuLimit = readNumber(sandbox, "cpu_limit");

  return {
    model: readString(config, "model") ?? defaultConfig.model,
    modelProvider: readString(config, "model_provider") ?? defaultConfig.modelProvider,
    approvalPolicy,
    sandboxMode,
    ...(selectedProfile ? { selectedProfile } : {}),
    features: {
      agenticSdlc: readBoolean(features, "agentic_sdlc") ?? defaultConfig.features.agenticSdlc,
      learningPlane:
        readBoolean(features, "learning_plane") ?? defaultConfig.features.learningPlane,
      subagents: readBoolean(features, "subagents") ?? defaultConfig.features.subagents,
      mcp: readBoolean(features, "mcp") ?? defaultConfig.features.mcp,
      skills: readBoolean(features, "skills") ?? defaultConfig.features.skills,
      hooks: readBoolean(features, "hooks") ?? defaultConfig.features.hooks,
      plugins: readBoolean(features, "plugins") ?? defaultConfig.features.plugins
    },
    learning: {
      mode: learningModeSchema.parse(readString(learning, "mode") ?? defaultConfig.learning.mode),
      redactSecrets:
        readBoolean(learning, "redact_secrets") ?? defaultConfig.learning.redactSecrets,
      requireUserConfirmation:
        readBoolean(learning, "require_user_confirmation") ??
        defaultConfig.learning.requireUserConfirmation
    },
    sdlc: {
      requirePlanForLargeChanges:
        readBoolean(sdlc, "require_plan_for_large_changes") ??
        defaultConfig.sdlc.requirePlanForLargeChanges,
      requireVerification:
        readBoolean(sdlc, "require_verification") ?? defaultConfig.sdlc.requireVerification,
      requireReviewForSecuritySensitiveChanges:
        readBoolean(sdlc, "require_review_for_security_sensitive_changes") ??
        defaultConfig.sdlc.requireReviewForSecuritySensitiveChanges
    },
    agent: {
      maxModelTurns:
        readPositiveInteger(agent, "max_model_turns") ?? defaultConfig.agent.maxModelTurns,
      maxToolCalls:
        readPositiveInteger(agent, "max_tool_calls") ?? defaultConfig.agent.maxToolCalls,
      maxRepeatedToolCalls:
        readPositiveInteger(agent, "max_repeated_tool_calls") ??
        defaultConfig.agent.maxRepeatedToolCalls,
      maxSubagents: readPositiveInteger(agent, "max_subagents") ?? defaultConfig.agent.maxSubagents,
      criticMode:
        parseAgentCriticMode(readString(agent, "critic_mode")) ?? defaultConfig.agent.criticMode,
      maxObservationChars:
        readPositiveInteger(agent, "max_observation_chars") ??
        defaultConfig.agent.maxObservationChars
    },
    security: {
      networkDefault:
        parseNetworkDefault(readString(security, "network_default")) ??
        defaultConfig.security.networkDefault,
      protectedPaths:
        readStringArray(security, "protected_paths") ?? defaultConfig.security.protectedPaths,
      secretsScanning:
        readBoolean(security, "secrets_scanning") ?? defaultConfig.security.secretsScanning,
      promptInjectionDetection:
        readBoolean(security, "prompt_injection_detection") ??
        defaultConfig.security.promptInjectionDetection,
      requireHardSandbox:
        readBoolean(security, "require_hard_sandbox") ?? defaultConfig.security.requireHardSandbox
    },
    sandbox: {
      preferredAdapter:
        parseSandboxPreferredAdapter(readString(sandbox, "preferred_adapter")) ??
        defaultConfig.sandbox.preferredAdapter,
      containerRuntime:
        parseContainerRuntime(readString(sandbox, "container_runtime")) ??
        defaultConfig.sandbox.containerRuntime,
      containerImage:
        readString(sandbox, "container_image") ?? defaultConfig.sandbox.containerImage,
      containerNetwork:
        parseContainerNetwork(readString(sandbox, "container_network")) ??
        defaultConfig.sandbox.containerNetwork,
      envAllowlist: readStringArray(sandbox, "env_allowlist") ?? defaultConfig.sandbox.envAllowlist,
      timeoutMs: readNumber(sandbox, "timeout_ms") ?? defaultConfig.sandbox.timeoutMs,
      ...(sandboxMemoryLimitMb !== undefined ? { memoryLimitMb: sandboxMemoryLimitMb } : {}),
      ...(sandboxCpuLimit !== undefined ? { cpuLimit: sandboxCpuLimit } : {})
    },
    policy: {
      allowedProviders:
        readStringArray(policy, "allowed_providers") ?? defaultConfig.policy.allowedProviders,
      allowedModels:
        readStringArray(policy, "allowed_models") ?? defaultConfig.policy.allowedModels,
      allowedMcpServers:
        readStringArray(policy, "allowed_mcp_servers") ?? defaultConfig.policy.allowedMcpServers
    },
    retention: {
      localLogsDays:
        readNumber(retention, "local_logs_days") ?? defaultConfig.retention.localLogsDays,
      eventLogsDays:
        readNumber(retention, "event_logs_days") ?? defaultConfig.retention.eventLogsDays,
      memoryRetention: "until_deleted",
      cloudSync: readBoolean(retention, "cloud_sync") ?? defaultConfig.retention.cloudSync
    },
    telemetry: {
      operationalMetrics:
        readBoolean(telemetry, "operational_metrics") ?? defaultConfig.telemetry.operationalMetrics,
      productAnalytics:
        readBoolean(telemetry, "product_analytics") ?? defaultConfig.telemetry.productAnalytics,
      contentTelemetry:
        readBoolean(telemetry, "content_telemetry") ?? defaultConfig.telemetry.contentTelemetry,
      crashReports: readBoolean(telemetry, "crash_reports") ?? defaultConfig.telemetry.crashReports,
      enterpriseAudit:
        readBoolean(telemetry, "enterprise_audit") ?? defaultConfig.telemetry.enterpriseAudit
    },
    tui: {
      statusLineItems: readStringArray(tuiStatusLine, "items") ?? defaultConfig.tui.statusLineItems
    },
    providers: mergeProviderConfigs(defaultConfig.providers, providers),
    sources
  };
}

function normalizeResolved(
  config: Omit<ResolvedConfig, "sources" | "selectedProfile">
): PartialConfig {
  return {
    model: config.model,
    model_provider: config.modelProvider,
    approval_policy: config.approvalPolicy,
    sandbox_mode: config.sandboxMode,
    features: {
      agentic_sdlc: config.features.agenticSdlc,
      learning_plane: config.features.learningPlane,
      subagents: config.features.subagents,
      mcp: config.features.mcp,
      skills: config.features.skills,
      hooks: config.features.hooks,
      plugins: config.features.plugins
    },
    learning: {
      mode: config.learning.mode,
      redact_secrets: config.learning.redactSecrets,
      require_user_confirmation: config.learning.requireUserConfirmation
    },
    sdlc: {
      require_plan_for_large_changes: config.sdlc.requirePlanForLargeChanges,
      require_verification: config.sdlc.requireVerification,
      require_review_for_security_sensitive_changes:
        config.sdlc.requireReviewForSecuritySensitiveChanges
    },
    agent: {
      max_model_turns: config.agent.maxModelTurns,
      max_tool_calls: config.agent.maxToolCalls,
      max_repeated_tool_calls: config.agent.maxRepeatedToolCalls,
      max_subagents: config.agent.maxSubagents,
      critic_mode: config.agent.criticMode,
      max_observation_chars: config.agent.maxObservationChars
    },
    security: {
      network_default: config.security.networkDefault,
      protected_paths: config.security.protectedPaths,
      secrets_scanning: config.security.secretsScanning,
      prompt_injection_detection: config.security.promptInjectionDetection,
      require_hard_sandbox: config.security.requireHardSandbox
    },
    sandbox: {
      preferred_adapter: config.sandbox.preferredAdapter,
      container_runtime: config.sandbox.containerRuntime,
      container_image: config.sandbox.containerImage,
      container_network: config.sandbox.containerNetwork,
      env_allowlist: config.sandbox.envAllowlist,
      timeout_ms: config.sandbox.timeoutMs,
      ...(config.sandbox.memoryLimitMb !== undefined
        ? { memory_limit_mb: config.sandbox.memoryLimitMb }
        : {}),
      ...(config.sandbox.cpuLimit !== undefined ? { cpu_limit: config.sandbox.cpuLimit } : {})
    },
    policy: {
      allowed_providers: config.policy.allowedProviders,
      allowed_models: config.policy.allowedModels,
      allowed_mcp_servers: config.policy.allowedMcpServers
    },
    retention: {
      local_logs_days: config.retention.localLogsDays,
      event_logs_days: config.retention.eventLogsDays,
      memory_retention: config.retention.memoryRetention,
      cloud_sync: config.retention.cloudSync
    },
    telemetry: {
      operational_metrics: config.telemetry.operationalMetrics,
      product_analytics: config.telemetry.productAnalytics,
      content_telemetry: config.telemetry.contentTelemetry,
      crash_reports: config.telemetry.crashReports,
      enterprise_audit: config.telemetry.enterpriseAudit
    },
    tui: {
      status_line: {
        items: config.tui.statusLineItems
      }
    },
    providers: writeProviderConfigs(config.providers)
  };
}

function mergeDeep(base: PartialConfig, override: PartialConfig): PartialConfig {
  const result: PartialConfig = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = result[key];
    if (isRecord(current) && isRecord(value)) {
      result[key] = mergeDeep(current, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function isRecord(value: unknown): value is PartialConfig {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRecord(source: PartialConfig | undefined, key: string): PartialConfig | undefined {
  const value = source?.[key];
  return isRecord(value) ? value : undefined;
}

function readString(source: PartialConfig, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" ? value : undefined;
}

function readBoolean(source: PartialConfig, key: string): boolean | undefined {
  const value = source[key];
  return typeof value === "boolean" ? value : undefined;
}

function readStringArray(source: PartialConfig, key: string): string[] | undefined {
  const value = source[key];
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function readNumber(source: PartialConfig, key: string): number | undefined {
  const value = source[key];
  return typeof value === "number" ? value : undefined;
}

function readPositiveInteger(source: PartialConfig, key: string): number | undefined {
  const value = readNumber(source, key);
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined;
}

function parseAgentCriticMode(value: string | undefined): AgentCriticMode | undefined {
  if (value === "off" || value === "after_mutation" || value === "always") {
    return value;
  }
  return undefined;
}

function parseSandboxPreferredAdapter(
  value: string | undefined
): SandboxConfig["preferredAdapter"] | undefined {
  if (value === "auto" || value === "typescript" || value === "docker" || value === "podman") {
    return value;
  }
  return undefined;
}

function parseContainerRuntime(
  value: string | undefined
): SandboxConfig["containerRuntime"] | undefined {
  if (value === "auto" || value === "docker" || value === "podman") {
    return value;
  }
  return undefined;
}

function parseContainerNetwork(
  value: string | undefined
): SandboxConfig["containerNetwork"] | undefined {
  if (value === "none" || value === "host") {
    return value;
  }
  return undefined;
}

function mergeProviderConfigs(
  defaults: ProviderConfigMap,
  source: PartialConfig
): ProviderConfigMap {
  const providers: ProviderConfigMap = { ...defaults };
  for (const [providerId, rawValue] of Object.entries(source)) {
    if (!isRecord(rawValue)) {
      continue;
    }
    providers[providerId] = {
      ...(providers[providerId] ?? {}),
      ...readProviderConfig(rawValue)
    };
  }
  return providers;
}

function readProviderConfig(source: PartialConfig): ProviderConfig {
  const apiKeyEnv = readString(source, "api_key_env");
  const baseUrl = readString(source, "base_url");
  const authFile = readString(source, "auth_file");
  const organization = readString(source, "organization");
  const project = readString(source, "project");
  const timeoutMs = readNumber(source, "timeout_ms");
  return {
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(authFile ? { authFile } : {}),
    ...(organization ? { organization } : {}),
    ...(project ? { project } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {})
  };
}

function writeProviderConfigs(source: ProviderConfigMap): PartialConfig {
  const providers: PartialConfig = {};
  for (const [providerId, provider] of Object.entries(source)) {
    providers[providerId] = {
      ...(provider.apiKeyEnv ? { api_key_env: provider.apiKeyEnv } : {}),
      ...(provider.baseUrl ? { base_url: provider.baseUrl } : {}),
      ...(provider.authFile ? { auth_file: provider.authFile } : {}),
      ...(provider.organization ? { organization: provider.organization } : {}),
      ...(provider.project ? { project: provider.project } : {}),
      ...(provider.timeoutMs ? { timeout_ms: provider.timeoutMs } : {})
    };
  }
  return providers;
}

function parseNetworkDefault(value: string | undefined): "off" | "on" | "restricted" | undefined {
  if (value === "off" || value === "on" || value === "restricted") {
    return value;
  }
  return undefined;
}
