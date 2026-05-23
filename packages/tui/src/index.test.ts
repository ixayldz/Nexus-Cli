import { describe, expect, it } from "vitest";
import { defaultConfig } from "@nexus/config";
import { type SessionId } from "@nexus/shared";
import {
  createInitialTuiState,
  parseSlashCommand,
  reduceTuiEvent,
  renderSlashPalette,
  renderStatusLine
} from "./index.js";

describe("tui reducer and slash commands", () => {
  it("renders status from config and session events", () => {
    let state = createInitialTuiState({ ...defaultConfig, sources: [] });
    state = reduceTuiEvent(state, {
      schemaVersion: 1,
      id: "evt_1" as never,
      sessionId: "nx_test" as SessionId,
      timestamp: "2026-05-20T00:00:00.000Z",
      type: "session.started",
      cwd: "repo",
      mode: "interactive"
    });

    expect(renderStatusLine(state)).toContain("model: deepseek/deepseek-v4-flash");
    expect(renderStatusLine(state)).toContain("session: nx_test");
  });

  it("maps slash commands to intents", () => {
    expect(parseSlashCommand("/status")).toEqual({ type: "status.show" });
    expect(parseSlashCommand("/quit")).toEqual({ type: "session.quit" });
    expect(parseSlashCommand("/goal Fix tests")).toMatchObject({
      type: "sdlc.goal.set",
      command: "/goal",
      argument: "Fix tests"
    });
    expect(parseSlashCommand("/plan")).toMatchObject({ type: "sdlc.plan", command: "/plan" });
    expect(parseSlashCommand("/ship")).toMatchObject({ type: "ship.start", command: "/ship" });
    expect(parseSlashCommand("/rollback checkpoint_1")).toMatchObject({
      type: "rollback.start",
      command: "/rollback",
      argument: "checkpoint_1"
    });
    expect(parseSlashCommand("/mcp")).toMatchObject({ type: "mcp.open", command: "/mcp" });
    expect(parseSlashCommand("/skills")).toMatchObject({ type: "skills.open", command: "/skills" });
    expect(parseSlashCommand("/hooks")).toMatchObject({ type: "hooks.open", command: "/hooks" });
    expect(parseSlashCommand("/agent")).toMatchObject({ type: "agent.open", command: "/agent" });
    expect(parseSlashCommand("/memories accept")).toMatchObject({
      type: "memories.open",
      command: "/memories",
      argument: "accept"
    });
    expect(parseSlashCommand("/ps")).toMatchObject({ type: "process.list", command: "/ps" });
    expect(parseSlashCommand("/approve-session approval_1")).toMatchObject({
      type: "approval.approve_session",
      command: "/approve-session",
      argument: "approval_1"
    });
    expect(parseSlashCommand("/fast")).toMatchObject({ type: "model.fast", command: "/fast" });
    expect(parseSlashCommand("/mention src/index.ts")).toMatchObject({
      type: "mention.add",
      command: "/mention",
      argument: "src/index.ts"
    });
    expect(parseSlashCommand("/sandbox-add-read-dir ../shared")).toMatchObject({
      type: "sandbox.add_read_dir",
      command: "/sandbox-add-read-dir",
      argument: "../shared"
    });
    expect(parseSlashCommand("/plugins")).toMatchObject({
      type: "plugins.open",
      command: "/plugins"
    });
    expect(renderSlashPalette()).toContain("/status");
  });

  it("renders sdlc and learning events", () => {
    let state = createInitialTuiState({ ...defaultConfig, sources: [] });
    state = reduceTuiEvent(state, {
      schemaVersion: 1,
      id: "evt_1" as never,
      sessionId: "nx_test" as SessionId,
      timestamp: "2026-05-20T00:00:00.000Z",
      type: "sdlc.goal.updated",
      goal: "Ship Phase 4"
    });
    state = reduceTuiEvent(state, {
      schemaVersion: 1,
      id: "evt_2" as never,
      sessionId: "nx_test" as SessionId,
      timestamp: "2026-05-20T00:00:00.000Z",
      type: "learning.candidate.created",
      candidate: {
        type: "workflow",
        text: "Use `pnpm test` for verification.",
        confidence: 0.8
      }
    });

    expect(state.goal).toBe("Ship Phase 4");
    expect(state.pendingLearningCandidates).toBe(1);
    expect(renderStatusLine(state)).toContain("memories: 1");
    expect(state.transcript.at(-1)?.text).toContain("Learning candidate");
  });

  it("captures approval cards", () => {
    const state = reduceTuiEvent(createInitialTuiState({ ...defaultConfig, sources: [] }), {
      schemaVersion: 1,
      id: "evt_1" as never,
      sessionId: "nx_test" as SessionId,
      timestamp: "2026-05-20T00:00:00.000Z",
      type: "approval.required",
      tool: "shell.run",
      risk: "critical",
      reason: "approval required"
    });

    expect(state.pendingApproval).toMatchObject({ tool: "shell.run", risk: "critical" });
    expect(state.transcript.at(-1)?.text).toContain("Approval required");
  });

  it("renders streaming assistant and rollback events", () => {
    let state = createInitialTuiState({ ...defaultConfig, sources: [] });
    state = reduceTuiEvent(state, {
      schemaVersion: 1,
      id: "evt_1" as never,
      sessionId: "nx_test" as SessionId,
      timestamp: "2026-05-20T00:00:00.000Z",
      type: "assistant.delta",
      text: "partial"
    });
    state = reduceTuiEvent(state, {
      schemaVersion: 1,
      id: "evt_2" as never,
      sessionId: "nx_test" as SessionId,
      timestamp: "2026-05-20T00:00:00.000Z",
      type: "rollback.completed",
      checkpointId: "checkpoint_1"
    });
    state = reduceTuiEvent(state, {
      schemaVersion: 1,
      id: "evt_3" as never,
      sessionId: "nx_test" as SessionId,
      timestamp: "2026-05-20T00:00:00.000Z",
      type: "rollback.refused",
      refusedReason: "Path is protected by security policy."
    });

    expect(state.transcript.map((entry) => entry.text)).toEqual([
      "partial",
      "Rollback completed: checkpoint_1",
      "Rollback refused: Path is protected by security policy."
    ]);
  });
});
