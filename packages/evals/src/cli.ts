#!/usr/bin/env node

import { runBaselineEval } from "./index.js";

const report = await runBaselineEval({ cwd: process.cwd(), writeReport: true });
process.stdout.write(`${report.status}: ${report.results.length} eval result(s), ${report.releaseChecks.checks.length} release check(s)\n`);
if (report.status !== "passed") {
  process.exitCode = 1;
}
