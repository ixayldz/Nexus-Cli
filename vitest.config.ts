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
    include: [
      "packages/**/*.test.ts",
      "packages/**/*.test.tsx",
      "apps/**/*.test.ts",
      "apps/**/*.test.tsx"
    ],
    environment: "node",
    testTimeout: 20000,
    hookTimeout: 20000,
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "html", "lcov"],
      include: ["apps/**/src/**/*.{ts,tsx}", "packages/**/src/**/*.{ts,tsx}"],
      exclude: [
        "**/*.test.ts",
        "**/*.test.tsx",
        "**/*.spec.ts",
        "**/*.spec.tsx",
        "apps/cli/src/main.ts",
        "packages/evals/src/cli.ts",
        "packages/evals/src/deepseek-smoke.ts",
        "packages/evals/src/package-dry-run.ts",
        "packages/evals/src/provider-smoke.ts",
        "packages/evals/src/release-verify.ts",
        "packages/evals/src/security.ts",
        "**/dist/**",
        "**/fixtures/**",
        "packages/test-utils/**"
      ],
      thresholds: {
        lines: 70,
        statements: 70,
        functions: 70,
        branches: 55
      }
    }
  }
});
