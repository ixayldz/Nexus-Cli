import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const alias = (target: string) => fileURLToPath(new URL(target, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@nexus/shared": alias("./packages/shared/src/index.ts"),
      "@nexus/events": alias("./packages/events/src/index.ts"),
      "@nexus/config": alias("./packages/config/src/index.ts"),
      "@nexus/storage": alias("./packages/storage/src/index.ts"),
      "@nexus/security": alias("./packages/security/src/index.ts"),
      "@nexus/tool-bus": alias("./packages/tool-bus/src/index.ts"),
      "@nexus/context": alias("./packages/context/src/index.ts"),
      "@nexus/model-router": alias("./packages/model-router/src/index.ts"),
      "@nexus/runtime": alias("./packages/runtime/src/index.ts"),
      "@nexus/agent": alias("./packages/agent/src/index.ts"),
      "@nexus/mcp": alias("./packages/mcp/src/index.ts"),
      "@nexus/skills": alias("./packages/skills/src/index.ts"),
      "@nexus/hooks": alias("./packages/hooks/src/index.ts"),
      "@nexus/test-utils": alias("./packages/test-utils/src/index.ts")
    }
  },
  test: {
    include: ["packages/**/*.test.ts", "packages/**/*.test.tsx", "apps/**/*.test.ts", "apps/**/*.test.tsx"],
    environment: "node",
    testTimeout: 20000,
    hookTimeout: 20000
  }
});
