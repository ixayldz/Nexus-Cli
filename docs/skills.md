# Skills MVP

Skills provide task-specific guidance without injecting every detail into every prompt.

The MVP supports built-in skills and local JSON manifests under `.nexus/skills`.

```bash
node apps/cli/dist/main.js skills
```

Skill summaries may be injected into context; full skill content should only be loaded when needed.
