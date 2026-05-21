# Nexus Install

Nexus targets Node.js 22 or newer and pnpm workspaces.

```bash
pnpm install
pnpm build
pnpm --filter @nexus/cli dev -- --version
```

For local development, run the CLI through `apps/cli/dist/main.js` after `pnpm build`.

Useful verification commands:

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm eval:baseline
pnpm provider:smoke
pnpm verify:package
```

`pnpm provider:smoke` uses DeepSeek by default and skips cleanly when `DEEPSEEK_API_KEY` is not set. For hard sandbox validation, install Docker or Podman and run:

```bash
node apps/cli/dist/main.js sandbox doctor
```
