# Nexus Security Model

Nexus routes model actions through the Tool Bus and Security Runtime. Model output is never executed directly.

Core defaults:

- workspace writes are path-guarded
- protected paths require approval or are denied
- shell commands are structurally risk-scored for destructive filesystem, credential access, network, package install, deploy, process kill and local executable patterns
- network shell commands are policy-controlled, including indirect Node.js, Python and PowerShell network forms
- hard sandbox requirement fails closed when Docker or Podman is unavailable
- hard sandbox command execution runs through a container with `--network none` by default and an explicit environment allowlist
- MCP stdio execution requires feature enablement, project policy allowlisting, explicit approval and a trusted server record
- event logs and JSON serialization redact credential-like strings

Real provider keys must be supplied through environment variables. The release gate must not include credentials, private config or auth files.

Recommended release checks:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm eval:baseline
pnpm eval:security
pnpm provider:smoke
pnpm verify:package
```
