#!/usr/bin/env node

import { runSecurityFixtureEval } from "./index.js";

const result = runSecurityFixtureEval();
process.stdout.write(`${result.status}: ${result.summary}\n`);
if (result.details.length > 0) {
  process.stdout.write(`${result.details.join("\n")}\n`);
}
if (result.status === "failed") {
  process.exitCode = 1;
}
