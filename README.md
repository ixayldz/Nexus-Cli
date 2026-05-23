# Nexus-Cli

Nexus-Cli is a TypeScript AI coding CLI/TUI with repo context, provider adapters, sandboxed tool execution, MCP governance, release verification, and local learning artifacts.

The public package target is `@ixayldz/nexus-cli`; the binary name is `nexus`.

## Quick Start

```powershell
pnpm install
pnpm build
node apps/cli/dist/main.js --help
```

## DeepSeek Setup

Live model calls use DeepSeek by default:

```powershell
$env:DEEPSEEK_API_KEY = "..."
node apps/cli/dist/main.js exec "Analyze this repository"
```

For deterministic local tests, use the explicit fake profile:

```powershell
node apps/cli/dist/main.js exec --profile fake "Read package.json and summarize it"
```

## Quality Gates

```powershell
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:coverage
pnpm verify:release
```

External provider smoke checks are secret-gated:

```powershell
pnpm verify:external
```

## Package Smoke

```powershell
pnpm pack:cli
node apps/cli/dist/main.js --version
```

For detailed usage, provider setup, sandbox checks, artifacts, and release verification, see [usage.md](./usage.md).
