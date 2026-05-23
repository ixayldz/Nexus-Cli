import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConfig } from "./index.js";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("config resolver", () => {
  it("returns defaults when no config files exist", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "nexus-config-"));
    const config = await resolveConfig({ cwd: tempDir });
    expect(config.modelProvider).toBe("deepseek");
    expect(config.model).toBe("deepseek-v4-flash");
    expect(config.sandboxMode).toBe("workspace-write");
    expect(config.security.requireHardSandbox).toBe(false);
    expect(config.providers.deepseek).toMatchObject({
      apiKeyEnv: "DEEPSEEK_API_KEY",
      baseUrl: "https://api.deepseek.com"
    });
  });

  it("applies project config and CLI overrides", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "nexus-config-"));
    await mkdir(join(tempDir, ".nexus"));
    await writeFile(
      join(tempDir, ".nexus", "config.toml"),
      'model = "configured"\nsandbox_mode = "read-only"\n'
    );

    const config = await resolveConfig({
      cwd: tempDir,
      overrides: { model: "override", sandboxMode: "workspace-write" }
    });

    expect(config.model).toBe("override");
    expect(config.sandboxMode).toBe("workspace-write");
  });

  it("discovers project config from nested working directories", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "nexus-config-"));
    tempDir = projectRoot;
    await mkdir(join(projectRoot, ".nexus"), { recursive: true });
    await mkdir(join(projectRoot, "packages", "app", "src"), { recursive: true });
    await writeFile(
      join(projectRoot, ".nexus", "config.toml"),
      [
        'model_provider = "deepseek"',
        'model = "deepseek-v4-flash"',
        "[sdlc]",
        "require_plan_for_large_changes = false",
        "[policy]",
        'allowed_providers = ["deepseek"]'
      ].join("\n")
    );

    const config = await resolveConfig({ cwd: join(projectRoot, "packages", "app", "src") });

    expect(config.modelProvider).toBe("deepseek");
    expect(config.model).toBe("deepseek-v4-flash");
    expect(config.sdlc.requirePlanForLargeChanges).toBe(false);
    expect(config.policy.allowedProviders).toEqual(["deepseek"]);
    expect(
      config.sources.some((source) => source.path === join(projectRoot, ".nexus", "config.toml"))
    ).toBe(true);
  });

  it("parses provider-specific configuration", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "nexus-config-"));
    await mkdir(join(tempDir, ".nexus"));
    await writeFile(
      join(tempDir, ".nexus", "config.toml"),
      [
        'model_provider = "openai"',
        'model = "gpt-5.5"',
        "[providers.openai]",
        'api_key_env = "CUSTOM_OPENAI_KEY"',
        'base_url = "https://api.example.test/v1"',
        'auth_file = ".nexus/auth.json"',
        'organization = "org_123"',
        'project = "proj_123"',
        "timeout_ms = 1234"
      ].join("\n")
    );

    const config = await resolveConfig({ cwd: tempDir });

    expect(config.modelProvider).toBe("openai");
    expect(config.providers.openai).toMatchObject({
      apiKeyEnv: "CUSTOM_OPENAI_KEY",
      baseUrl: "https://api.example.test/v1",
      authFile: ".nexus/auth.json",
      organization: "org_123",
      project: "proj_123",
      timeoutMs: 1234
    });
  });

  it("parses hard sandbox and DeepSeek provider configuration", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "nexus-config-"));
    await mkdir(join(tempDir, ".nexus"));
    await writeFile(
      join(tempDir, ".nexus", "config.toml"),
      [
        'model_provider = "deepseek"',
        'model = "deepseek-v4-flash"',
        "[security]",
        "require_hard_sandbox = true",
        "[providers.deepseek]",
        'api_key_env = "CUSTOM_DEEPSEEK_KEY"',
        'base_url = "https://api.deepseek.example"'
      ].join("\n")
    );

    const config = await resolveConfig({ cwd: tempDir });

    expect(config.modelProvider).toBe("deepseek");
    expect(config.model).toBe("deepseek-v4-flash");
    expect(config.security.requireHardSandbox).toBe(true);
    expect(config.providers.deepseek).toMatchObject({
      apiKeyEnv: "CUSTOM_DEEPSEEK_KEY",
      baseUrl: "https://api.deepseek.example"
    });
  });

  it("parses sandbox container configuration", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "nexus-config-"));
    await mkdir(join(tempDir, ".nexus"));
    await writeFile(
      join(tempDir, ".nexus", "config.toml"),
      [
        "[sandbox]",
        'preferred_adapter = "docker"',
        'container_runtime = "docker"',
        'container_image = "node:22-bookworm-slim"',
        'container_network = "none"',
        'env_allowlist = ["PATH", "DEEPSEEK_API_KEY"]',
        "timeout_ms = 120000",
        "memory_limit_mb = 1024",
        "cpu_limit = 2"
      ].join("\n")
    );

    const config = await resolveConfig({ cwd: tempDir });

    expect(config.sandbox).toMatchObject({
      preferredAdapter: "docker",
      containerRuntime: "docker",
      containerImage: "node:22-bookworm-slim",
      containerNetwork: "none",
      envAllowlist: ["PATH", "DEEPSEEK_API_KEY"],
      timeoutMs: 120000,
      memoryLimitMb: 1024,
      cpuLimit: 2
    });
  });

  it("supports the built-in fake profile for deterministic local tests", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "nexus-config-"));
    const config = await resolveConfig({ cwd: tempDir, overrides: { profile: "fake" } });

    expect(config.modelProvider).toBe("fake");
    expect(config.model).toBe("fake-default");
  });

  it("supports the built-in DeepSeek profile", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "nexus-config-"));
    const config = await resolveConfig({ cwd: tempDir, overrides: { profile: "deepseek" } });

    expect(config.modelProvider).toBe("deepseek");
    expect(config.model).toBe("deepseek-v4-flash");
  });

  it("parses policy, retention, and telemetry controls", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "nexus-config-"));
    await mkdir(join(tempDir, ".nexus"));
    await writeFile(
      join(tempDir, ".nexus", "config.toml"),
      [
        "[policy]",
        'allowed_providers = ["deepseek"]',
        'allowed_models = ["deepseek-v4-flash"]',
        'allowed_mcp_servers = ["local"]',
        "[retention]",
        "local_logs_days = 7",
        "event_logs_days = 14",
        "cloud_sync = false",
        "[telemetry]",
        "operational_metrics = false",
        "product_analytics = false",
        "content_telemetry = false",
        "crash_reports = false",
        "enterprise_audit = true"
      ].join("\n")
    );

    const config = await resolveConfig({ cwd: tempDir });

    expect(config.policy.allowedProviders).toEqual(["deepseek"]);
    expect(config.policy.allowedModels).toEqual(["deepseek-v4-flash"]);
    expect(config.policy.allowedMcpServers).toEqual(["local"]);
    expect(config.retention.localLogsDays).toBe(7);
    expect(config.retention.eventLogsDays).toBe(14);
    expect(config.telemetry.enterpriseAudit).toBe(true);
    expect(config.telemetry.contentTelemetry).toBe(false);
  });
});
