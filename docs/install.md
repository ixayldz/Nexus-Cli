# Nexus Install

Nexus targets Node.js 22 or newer and pnpm workspaces.

```bash
pnpm install
pnpm build
pnpm --filter @ixayldz/nexus-cli dev -- --version
```

For local development, run the CLI through `apps/cli/dist/main.js` after `pnpm build`.

Published package target:

```bash
npm install -g @ixayldz/nexus-cli
nexus --help
```

Useful verification commands:

```bash
pnpm typecheck
pnpm test:coverage
pnpm lint
pnpm eval:baseline
pnpm verify:package
pnpm verify:release
```

`pnpm verify:external` uses DeepSeek and skips cleanly when `DEEPSEEK_API_KEY` is not set. For hard sandbox validation, install Docker or Podman and run:

```bash
node apps/cli/dist/main.js sandbox doctor
```
