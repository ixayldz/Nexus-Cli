# Rollback

File mutations create checkpoints under the session run directory. Rollback restores the latest checkpoint or a named checkpoint through the same security path guard used for writes.

```bash
node apps/cli/dist/main.js exec --verify "pnpm test" --rollback-on-verify-fail "write hello"
```

Interactive sessions can use:

```text
/rollback
/rollback <checkpoint-id>
```

Rollback refuses protected or workspace-escaping targets.

