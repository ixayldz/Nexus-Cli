import { describe, expect, it } from "vitest";
import { InMemoryEventBus } from "@nexus/events";
import { type SessionId } from "@nexus/shared";
import { SdlcManager } from "./index.js";

const compiledContext = {
  cwd: ".",
  model: "fake",
  modelProvider: "fake",
  repository: {
    repoRoot: ".",
    hasPackageJson: true,
    packageManager: "pnpm" as const,
    topLevelFiles: ["package.json"],
    packageScripts: { test: "vitest", typecheck: "tsc --noEmit" },
    testCommands: ["pnpm test", "pnpm typecheck"],
    workspacePackages: [],
    symbols: [
      {
        name: "value",
        kind: "const" as const,
        path: "src/feature.ts",
        line: 1,
        exported: true
      }
    ],
    testMap: [
      {
        sourcePath: "src/feature.ts",
        testPaths: ["src/feature.test.ts"],
        command: "pnpm test"
      }
    ],
    repoMap: {
      root: ".",
      directories: ["packages"],
      files: [{ path: "package.json", size: 100 }],
      truncated: false
    },
    git: {
      available: false,
      branch: "unknown",
      status: "",
      diff: ""
    }
  },
  mentions: [],
  memories: {
    project: "",
    user: "",
    paths: {
      project: ".nexus/learning/project-memory.md",
      user: ".nexus/memories/user-memory.md"
    }
  },
  toolOutputs: [],
  tokenBudget: {
    estimatedInputTokens: 0,
    maxContextTokens: 128000,
    truncated: false
  },
  compactSummary: "test context",
  security: {
    promptInjectionFindings: []
  }
};

describe("sdlc manager", () => {
  it("sets a goal and emits definition of done", async () => {
    const manager = new SdlcManager();
    const bus = new InMemoryEventBus();
    const events: string[] = [];
    bus.subscribe((event) => {
      events.push(event.type);
    });

    const state = await manager.setGoal({
      sessionId: "nx_test" as SessionId,
      eventBus: bus,
      goal: "Fix tests",
      createdAt: "2026-05-20T00:00:00.000Z"
    });

    expect(state.goal?.text).toBe("Fix tests");
    expect(state.definitionOfDone).toHaveLength(3);
    expect(events).toEqual(["sdlc.goal.updated", "sdlc.definition_of_done.updated"]);
  });

  it("creates a structured plan", async () => {
    const manager = new SdlcManager();
    const plan = await manager.createPlan({
      sessionId: "nx_test" as SessionId,
      eventBus: new InMemoryEventBus(),
      context: compiledContext,
      prompt: "Fix tests"
    });

    expect(plan.goal).toBe("Fix tests");
    expect(plan.verification.at(0)?.command).toBe("pnpm test");
  });

  it("discovers context and records verification/review stage state", async () => {
    const manager = new SdlcManager();
    const eventBus = new InMemoryEventBus();

    const discovery = await manager.discover({
      sessionId: "nx_test" as SessionId,
      eventBus,
      context: compiledContext
    });
    const verification = await manager.verify({
      sessionId: "nx_test" as SessionId,
      eventBus,
      command: "pnpm test",
      status: "passed",
      summary: "ok"
    });
    const review = await manager.review({
      sessionId: "nx_test" as SessionId,
      eventBus,
      filesChanged: ["src/feature.ts"],
      diff: "diff --git a/src/feature.ts b/src/feature.ts\n+export const value = 1;"
    });

    expect(discovery.testCommands).toContain("pnpm test");
    expect(verification.status).toBe("passed");
    expect(review.status).toBe("warnings");
    expect(manager.getState().completedStages).toEqual(
      expect.arrayContaining(["discover", "verify", "review"])
    );
  });

  it("flags package manifest changes without a lockfile", async () => {
    const manager = new SdlcManager();
    const review = await manager.review({
      sessionId: "nx_test" as SessionId,
      eventBus: new InMemoryEventBus(),
      filesChanged: ["package.json"],
      diff: [
        "diff --git a/package.json b/package.json",
        "@@ -4,6 +4,7 @@",
        '   "dependencies": {',
        '+    "left-pad": "1.3.0"',
        "   }"
      ].join("\n")
    });

    expect(review.status).toBe("warnings");
    expect(review.findings.map((finding) => finding.title)).toContain(
      "Package manifest changed without lockfile update"
    );
  });

  it("adds context-aware coverage hints for exported source changes", async () => {
    const manager = new SdlcManager();
    const review = await manager.review({
      sessionId: "nx_test" as SessionId,
      eventBus: new InMemoryEventBus(),
      filesChanged: ["src/feature.ts"],
      diff: [
        "diff --git a/src/feature.ts b/src/feature.ts",
        "@@ -1,1 +1,1 @@",
        "-export const value = 1;",
        "+export const value = 2;"
      ].join("\n"),
      context: compiledContext
    });

    expect(review.coverageHints).toContain("src/feature.ts: run or update src/feature.test.ts");
    expect(review.semanticFindings.length).toBeGreaterThan(0);
  });

  it("warns when exported source has no mapped focused test", async () => {
    const manager = new SdlcManager();
    const review = await manager.review({
      sessionId: "nx_test" as SessionId,
      eventBus: new InMemoryEventBus(),
      filesChanged: ["src/feature.ts"],
      context: {
        ...compiledContext,
        repository: {
          ...compiledContext.repository,
          testMap: []
        }
      }
    });

    expect(review.findings.map((finding) => finding.title)).toContain(
      "Exported source lacks mapped test coverage"
    );
  });

  it("fails review when focused tests are introduced", async () => {
    const manager = new SdlcManager();
    const review = await manager.review({
      sessionId: "nx_test" as SessionId,
      eventBus: new InMemoryEventBus(),
      filesChanged: ["src/feature.test.ts"],
      diff: [
        "diff --git a/src/feature.test.ts b/src/feature.test.ts",
        "@@ -1,2 +1,3 @@",
        '+test.only("critical path", () => {',
        "+  expect(true).toBe(true);",
        "+});"
      ].join("\n")
    });

    expect(review.status).toBe("failed");
    expect(review.findings.at(0)?.title).toBe("Focused test committed");
  });

  it("fails review when dynamic code execution is introduced", async () => {
    const manager = new SdlcManager();
    const review = await manager.review({
      sessionId: "nx_test" as SessionId,
      eventBus: new InMemoryEventBus(),
      filesChanged: ["src/runtime.ts"],
      diff: [
        "diff --git a/src/runtime.ts b/src/runtime.ts",
        "@@ -1,2 +1,3 @@",
        "+export function runUserCode(input: string) {",
        "+  return eval(input);",
        "+}"
      ].join("\n")
    });

    expect(review.status).toBe("failed");
    expect(review.findings.map((finding) => finding.title)).toContain(
      "Dynamic code execution introduced"
    );
  });

  it("blocks ship when gates are missing and passes after verification/review", async () => {
    const manager = new SdlcManager();
    const eventBus = new InMemoryEventBus();
    const blocked = await manager.ship({
      sessionId: "nx_test" as SessionId,
      eventBus,
      filesChanged: ["src/feature.ts"],
      commandsRun: []
    });
    expect(blocked.status).toBe("blocked");

    await manager.verify({
      sessionId: "nx_test" as SessionId,
      eventBus,
      command: "pnpm test",
      status: "passed",
      summary: "ok"
    });
    await manager.review({
      sessionId: "nx_test" as SessionId,
      eventBus,
      filesChanged: ["src/feature.ts"]
    });
    const ready = await manager.ship({
      sessionId: "nx_test" as SessionId,
      eventBus,
      filesChanged: ["src/feature.ts"],
      commandsRun: ["pnpm test"]
    });
    expect(ready.status).toBe("ready");
  });
});
