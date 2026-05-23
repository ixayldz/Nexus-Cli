# Security Policy

## Supported Versions

Only the latest released version is supported for security fixes.

## Reporting a Vulnerability

Do not open a public issue for secrets, credential exposure, sandbox bypasses, provider-auth bugs, or filesystem escape reports.

Send a private report to the repository owner through GitHub security advisories. Include:

- Affected version or commit SHA.
- Reproduction steps.
- Expected and actual behavior.
- Impact assessment.
- Any logs with secrets redacted.

## Security Baseline

The repository expects these gates before release:

- CodeQL JavaScript/TypeScript analysis.
- Dependency review on pull requests.
- `pnpm audit --audit-level high`.
- Secret scanning and push protection enabled in GitHub repository settings.
- Package dry-run verification before npm publish.
