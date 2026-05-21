# Troubleshooting

Common checks:

```bash
pnpm build
pnpm test
pnpm lint
pnpm typecheck
pnpm eval:baseline
pnpm verify:package
```

If live provider smoke tests are skipped, confirm `DEEPSEEK_API_KEY` is set in the shell environment. Never paste live credentials into tracked files or issue bodies.

Mutation blocked before tools run:

- In non-interactive mode, model-driven `file.write` and `patch.apply` require a recorded and approved implementation plan. Without approval, the CLI exits with code 2.
- In interactive mode, approve the generated `sdlc.plan` request with `/approve`, then approve any follow-up tool or verification requests required by the configured approval policy.

MCP tool execution blocked:

- Confirm the server is present and `enabled: true` in `.nexus/mcp.json`.
- If `[policy].allowed_mcp_servers` is non-empty, the server id must be listed there.
- v1.0 executes stdio MCP servers only.
