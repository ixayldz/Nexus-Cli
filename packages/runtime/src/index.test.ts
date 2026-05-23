import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "@nexus/config";
import { InMemoryEventBus, createEvent, readJsonlEvents } from "@nexus/events";
import { DefaultModelRouter, ModelProviderRegistry } from "@nexus/model-router";
import { SecurityRuntime } from "@nexus/security";
import { type SessionId } from "@nexus/shared";
import { createDefaultToolBus } from "@nexus/tool-bus";
import { NexusRuntime, createDefaultRuntimeServices, type TurnRunner } from "./index.js";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("runtime session foundation", () => {
  it("starts, completes, resumes and forks sessions with manifest metadata", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "nexus-runtime-"));
    const runtime = makeRuntime();
    const session = await runtime.startSession({ cwd: tempDir, mode: "non-interactive" });
    await runtime.eventBus.publish(
      createEvent({
        sessionId: session.id,
        threadId: session.activeThreadId,
        type: "user.input",
        data: { text: "resume this work" }
      })
    );
    await runtime.eventBus.publish(
      createEvent({
        sessionId: session.id,
        threadId: session.activeThreadId,
        type: "sdlc.goal.updated",
        data: { goal: "Resume goal" }
      })
    );
    await runtime.eventBus.publish(
      createEvent({
        sessionId: session.id,
        threadId: session.activeThreadId,
        type: "assistant.message",
        data: { text: "previous answer" }
      })
    );
    await runtime.complete({
      finalMessage: "done",
      filesChanged: ["a.ts"],
      commandsRun: ["pnpm test"]
    });

    const events = await readJsonlEvents(session.eventLogPath);
    expect(events.map((event) => event.type)).toContain("session.started");
    expect(events.map((event) => event.type)).toContain("session.completed");

    const resumeRuntime = makeRuntime();
    const resumed = await resumeRuntime.resumeSession({
      cwd: tempDir,
      last: true,
      mode: "interactive"
    });
    expect(resumed.id).toBe(session.id);
    const services = runtimeServices(resumeRuntime);
    const context = await services.context.compile({
      cwd: tempDir,
      config: { ...defaultConfig, sources: [] }
    });
    expect(context.sessionReplay?.transcript.map((item) => item.text)).toEqual(
      expect.arrayContaining(["resume this work", "previous answer"])
    );
    expect(services.sdlc.getState().goal?.text).toBe("Resume goal");

    const forked = await resumeRuntime.forkSession(session.id, {
      cwd: tempDir,
      mode: "interactive"
    });
    expect(forked.id).not.toBe(session.id);
    expect(forked.parentSessionId).toBe(session.id);
  });

  it("approves pending requests through the shared approval coordinator", async () => {
    const runtime = makeRuntime();
    const sessionId = "nx_test" as SessionId;
    const request = runtimeServices(runtime).approvals.request({
      sessionId,
      toolName: "shell.run",
      risk: "high",
      reason: "test",
      fingerprint: "shell.run:test"
    });
    const decision = runtimeServices(runtime).approvals.waitForDecision(request.id);

    await runtime.approve(request.id);

    await expect(decision).resolves.toEqual({ id: request.id, decision: "approved" });
  });
});

function makeRuntime(): NexusRuntime {
  return new NexusRuntime({
    config: { ...defaultConfig, sources: [] },
    services: createServices(),
    turnRunner: runner,
    eventBus: new InMemoryEventBus()
  });
}

function createServices() {
  return createDefaultRuntimeServices({
    models: new DefaultModelRouter(new ModelProviderRegistry()),
    tools: createDefaultToolBus(),
    security: new SecurityRuntime()
  });
}

function runtimeServices(runtime: NexusRuntime) {
  return (runtime as unknown as { services: ReturnType<typeof createServices> }).services;
}

const runner: TurnRunner = {
  async run() {
    return { finalMessage: "ok", filesChanged: [], commandsRun: [] };
  }
};
