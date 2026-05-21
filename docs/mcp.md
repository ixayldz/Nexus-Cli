# MCP MVP

The MCP MVP stores local server configuration in `.nexus/mcp.json`.

```bash
node apps/cli/dist/main.js mcp
node apps/cli/dist/main.js mcp add local node server.js
node apps/cli/dist/main.js mcp trust local
node apps/cli/dist/main.js mcp allow-tool local search
node apps/cli/dist/main.js mcp remove local
```

MCP tools must be adapted into Nexus tools and routed through Tool Bus policy before execution.

Execution is intentionally gated. A server must be:

- enabled in `.nexus/mcp.json`
- allowed by `[policy].allowed_mcp_servers`
- marked with `"trust": "trusted"`
- approved at runtime
- restricted with `"allowedTools"` when possible

Example trusted local server:

```json
{
  "servers": [
    {
      "id": "local",
      "name": "Local MCP",
      "transport": "stdio",
      "command": "node",
      "args": ["server.js"],
      "enabled": true,
      "permissions": ["workspace.read"],
      "trust": "trusted",
      "allowedTools": ["search"],
      "envAllowlist": []
    }
  ]
}
```

Keep repository-supplied MCP configs untrusted until the command, arguments and tool list are reviewed.
