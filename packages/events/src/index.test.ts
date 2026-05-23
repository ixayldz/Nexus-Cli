import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { type SessionId, setIdCounterForTests, setNowForTests } from "@nexus/shared";
import {
  InMemoryEventBus,
  JsonlEventWriter,
  createEvent,
  readJsonlEvents,
  validateNexusEvent
} from "./index.js";

let tempDir: string | undefined;

afterEach(async () => {
  setIdCounterForTests(undefined);
  setNowForTests(undefined);
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("events", () => {
  it("publishes events in order", async () => {
    setIdCounterForTests(1);
    setNowForTests("2026-05-20T00:00:00.000Z");
    const bus = new InMemoryEventBus();
    const seen: string[] = [];
    bus.subscribe((event) => {
      seen.push(event.type);
    });

    const sessionId = "nx_test" as SessionId;
    await bus.publish(createEvent({ sessionId, type: "session.started" }));
    await bus.publish(createEvent({ sessionId, type: "session.completed" }));

    expect(seen).toEqual(["session.started", "session.completed"]);
  });

  it("writes and reads JSONL events", async () => {
    setIdCounterForTests(1);
    setNowForTests("2026-05-20T00:00:00.000Z");
    tempDir = await mkdtemp(join(tmpdir(), "nexus-events-"));
    const eventPath = join(tempDir, "events.jsonl");
    const writer = new JsonlEventWriter(eventPath);
    const sessionId = "nx_test" as SessionId;

    await writer.write(createEvent({ sessionId, type: "session.started" }));
    await writer.write(
      createEvent({ sessionId, type: "assistant.message", data: { text: "done" } })
    );

    const events = await readJsonlEvents(eventPath);
    expect(events.map((event) => event.type)).toEqual(["session.started", "assistant.message"]);
  });

  it("serializes concurrent JSONL writes", async () => {
    setIdCounterForTests(1);
    setNowForTests("2026-05-20T00:00:00.000Z");
    tempDir = await mkdtemp(join(tmpdir(), "nexus-events-"));
    const eventPath = join(tempDir, "events.jsonl");
    const writer = new JsonlEventWriter(eventPath, {
      allowedRoot: tempDir,
      workspaceRoot: tempDir,
      fsync: false
    });
    const sessionId = "nx_test" as SessionId;

    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        writer.write(
          createEvent({
            sessionId,
            type: "assistant.message",
            data: { text: `message ${index}` }
          })
        )
      )
    );

    const events = await readJsonlEvents(eventPath);
    expect(events).toHaveLength(10);
    expect(events.every((event) => event.type === "assistant.message")).toBe(true);
  });

  it("rejects symlinked event log targets", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "nexus-events-"));
    const externalDir = await mkdtemp(join(tmpdir(), "nexus-events-external-"));
    try {
      const externalLog = join(externalDir, "events.jsonl");
      await writeFile(externalLog, "", "utf8");
      try {
        await symlink(externalLog, join(tempDir, "events.jsonl"), "file");
      } catch {
        return;
      }
      const writer = new JsonlEventWriter(join(tempDir, "events.jsonl"), {
        allowedRoot: tempDir,
        workspaceRoot: tempDir,
        fsync: false
      });

      await expect(
        writer.write(createEvent({ sessionId: "nx_test" as SessionId, type: "session.started" }))
      ).rejects.toThrow("Event log path must not be a symlink");
    } finally {
      await rm(externalDir, { recursive: true, force: true });
    }
  });

  it("reports malformed JSONL line numbers", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "nexus-events-"));
    const eventPath = join(tempDir, "events.jsonl");
    await writeFile(eventPath, '{"not":"event"}\n', "utf8");

    await expect(readJsonlEvents(eventPath)).rejects.toThrow(":1:");
  });

  it("rejects unregistered event types", () => {
    expect(() =>
      validateNexusEvent({
        schemaVersion: 1,
        id: "evt_test",
        sessionId: "nx_test",
        timestamp: "2026-05-20T00:00:00.000Z",
        type: "unknown.event"
      })
    ).toThrow("not registered");
  });

  it("accepts agent orchestration event types", () => {
    const sessionId = "nx_test" as SessionId;

    expect(() =>
      validateNexusEvent(
        createEvent({
          sessionId,
          type: "agent.step.started",
          data: { phase: "execute", label: "Run search.files" }
        })
      )
    ).not.toThrow();
    expect(() =>
      validateNexusEvent(
        createEvent({
          sessionId,
          type: "agent.critic.completed",
          data: { decision: "finalize", summary: "ok" }
        })
      )
    ).not.toThrow();
    expect(() =>
      validateNexusEvent(
        createEvent({
          sessionId,
          type: "agent.loop.completed",
          data: { status: "completed", modelTurns: 2, toolCalls: 1 }
        })
      )
    ).not.toThrow();
  });
});
