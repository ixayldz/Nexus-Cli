import { describe, expect, it } from "vitest";
import { InMemoryEventBus, type NexusEvent } from "@nexus/events";
import { type SessionId } from "@nexus/shared";
import {
  assertNoUnredactedSecrets,
  runBaselineEval,
  runPackageDryRun,
  runGoldenEventEval,
  runReleaseChecks,
  runSecurityFixtureEval,
  securityFixtures
} from "./index.js";
import { runDogfoodEval } from "./dogfood.js";

describe("eval and release hardening", () => {
  it("passes golden event sequences in order", () => {
    const result = runGoldenEventEval({
      name: "runtime",
      events: [
        event("session.started"),
        event("user.input"),
        event("model.call.started"),
        event("model.call.completed"),
        event("assistant.message")
      ],
      expectedTypes: ["session.started", "user.input", "model.call.started", "model.call.completed"]
    });

    expect(result.status).toBe("passed");
  });

  it("fails golden event sequences when an event is missing", () => {
    const result = runGoldenEventEval({
      name: "runtime",
      events: [event("session.started")],
      expectedTypes: ["session.started", "model.call.completed"]
    });

    expect(result.status).toBe("failed");
    expect(result.details).toEqual(["model.call.completed"]);
  });

  it("detects unredacted secrets in event logs", () => {
    const result = assertNoUnredactedSecrets({
      name: "secrets",
      events: [event("assistant.message", { text: "leaked sk-secret123456" })]
    });

    expect(result.status).toBe("failed");
  });

  it("exposes security fixtures for hardening tests", () => {
    expect(securityFixtures.map((fixture) => fixture.name)).toContain("prompt injection");
    expect(securityFixtures.map((fixture) => fixture.name)).toContain("api key in memory");
  });

  it("passes release checks for the workspace package scripts", async () => {
    const result = await runReleaseChecks({ cwd: process.cwd() });

    expect(result.status).toBe("passed");
  });

  it("passes the security fixture baseline", () => {
    expect(runSecurityFixtureEval()).toMatchObject({ status: "passed" });
  });

  it("passes the baseline eval report", async () => {
    const result = await runBaselineEval({ cwd: process.cwd() });

    expect(result.status).toBe("passed");
  });

  it("passes the package dry-run safety checks", async () => {
    const result = await runPackageDryRun({ cwd: process.cwd() });

    expect(result.status).toBe("passed");
  });

  it("publishes baseline eval lifecycle events", async () => {
    const eventBus = new InMemoryEventBus();
    const seen: string[] = [];
    eventBus.subscribe((item) => {
      seen.push(item.type);
    });

    await runBaselineEval({ cwd: process.cwd(), eventBus });

    expect(seen).toEqual(["eval.started", "eval.completed"]);
  });

  it("passes the non-live dogfood eval corpus", async () => {
    const result = await runDogfoodEval({ cwd: process.cwd(), live: false });

    expect(result.status).toBe("passed");
    expect(result.results.map((item) => item.name)).toEqual(
      expect.arrayContaining([
        "read-only exec JSONL",
        "explicit mutation",
        "rollback on verify fail",
        "context symlink refusal",
        "MCP registry symlink refusal"
      ])
    );
  });
});

function event(type: string, data: Record<string, unknown> = {}): NexusEvent {
  return {
    schemaVersion: 1,
    id: `evt_${type}` as never,
    sessionId: "nx_test" as SessionId,
    timestamp: "2026-05-20T00:00:00.000Z",
    type: type as never,
    ...data
  };
}
