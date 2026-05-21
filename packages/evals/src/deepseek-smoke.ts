#!/usr/bin/env node

import { DeepSeekChatProvider } from "@nexus/provider-deepseek";
import { type SessionId } from "@nexus/shared";

if (!process.env.DEEPSEEK_API_KEY) {
  process.stdout.write("skipped: DEEPSEEK_API_KEY is not set\n");
} else {
  const provider = new DeepSeekChatProvider();
  const result = await provider.call({
    sessionId: "nx_deepseek_smoke" as SessionId,
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: "Reply with exactly: nexus-live-ok" }]
  });
  if (!result.message.toLowerCase().includes("nexus-live-ok")) {
    process.stderr.write(`failed: unexpected DeepSeek response: ${result.message}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("passed: DeepSeek live smoke\n");
  }
}
