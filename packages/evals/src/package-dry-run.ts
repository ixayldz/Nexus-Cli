import { runPackageDryRun } from "./index.js";

const result = await runPackageDryRun({ cwd: process.cwd() });
process.stdout.write(`${result.status}: ${result.checks.length} package dry-run check(s)\n`);
if (result.status !== "passed") {
  for (const check of result.checks.filter((item) => item.status === "failed")) {
    process.stderr.write(`${check.name}: ${check.summary}\n`);
  }
  process.exitCode = 1;
}
