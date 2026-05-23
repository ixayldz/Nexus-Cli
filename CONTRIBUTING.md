# Contributing

## Local Setup

```powershell
pnpm install
pnpm build
pnpm verify:local
```

## Quality Bar

Every pull request must pass:

- `pnpm format:check`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test:coverage`
- `pnpm eval:baseline`
- `pnpm eval:security`
- `pnpm verify:package`

Use `pnpm verify:external` only when `DEEPSEEK_API_KEY` is available. External provider checks are intentionally secret-gated and are not required for every local change.

## Pull Requests

- Keep changes scoped to one behavioral area.
- Update tests for every behavior change.
- Update `usage.md` or `docs/` when CLI behavior, config, release, security, or MCP behavior changes.
- Do not commit `.nexus`, `node_modules`, `dist`, `.env`, provider auth files, or generated secrets.
