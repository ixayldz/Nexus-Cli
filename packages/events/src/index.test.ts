import { mkdtemp, rm } from "node:fs/promises";
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
});
