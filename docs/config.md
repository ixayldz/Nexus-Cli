# Nexus Configuration

Configuration is loaded from system, user, project and explicit config files, then CLI overrides are applied.

Use the built-in DeepSeek profile for live provider validation:

```bash
set DEEPSEEK_API_KEY=<redacted>
node apps/cli/dist/main.js exec --profile deepseek "hello"
```

Do not write API keys into config files. Prefer environment variables or ignored local auth files.

Production-oriented gates are enabled by default:

```toml
[sdlc]
require_plan_for_large_changes = true
require_verification = true
require_review_for_security_sensitive_changes = true

[policy]
allowed_providers = ["deepseek"]
allowed_models = ["deepseek-v4-flash"]
allowed_mcp_servers = ["local"]

[telemetry]
operational_metrics = false
product_analytics = false
content_telemetry = false
crash_reports = false
enterprise_audit = true

[sandbox]
preferred_adapter = "auto"
container_runtime = "auto"
container_image = "node:22-bookworm-slim"
container_network = "none"
env_allowlist = ["PATH", "HOME", "USERPROFILE", "TMP", "TEMP", "PNPM_HOME", "DEEPSEEK_API_KEY"]
timeout_ms = 300000
memory_limit_mb = 2048
cpu_limit = 2
```

`allowed_*` lists are allowlists only when non-empty. Leave them empty for local development, and set them in project or enterprise config for release workflows. MCP tool execution uses `mcp.call` and only runs enabled stdio servers from `.nexus/mcp.json`.

Run sandbox diagnostics before enabling hard sandbox in CI:

```bash
node apps/cli/dist/main.js sandbox doctor
```

When `[security].require_hard_sandbox = true`, Tool Bus fails closed unless Docker or Podman is available.
