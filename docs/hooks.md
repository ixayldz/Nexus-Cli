# Hooks MVP

Hooks are lifecycle automation commands configured in `.nexus/hooks.json`.

Hooks run through the Tool Bus and are subject to the same policy, approval and sandbox checks as other shell commands.

```json
{
  "hooks": [
    {
      "id": "before-verify",
      "event": "before_verify",
      "command": "pnpm lint",
      "enabled": true,
      "requiredPermissions": []
    }
  ]
}
```
