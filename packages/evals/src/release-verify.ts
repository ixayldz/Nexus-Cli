#!/usr/bin/env node

import { runPackageDryRun, runReleaseChecks } from "./index.js";

const cwd = process.cwd();
const release = await runReleaseChecks({ cwd });
const packaging = await runPackageDryRun({ cwd });
for (const check of [...release.checks, ...packaging.checks]) {
  process.stdout.write(`${check.status}: ${check.name} - ${check.summary}\n`);
}
if (release.status === "failed" || packaging.status === "failed") {
  process.exitCode = 1;
}
