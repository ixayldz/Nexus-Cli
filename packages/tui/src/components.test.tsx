import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { defaultConfig } from "@nexus/config";
import { NexusTuiApp, createInitialTuiState, reduceTuiEvent, type RuntimeIntent } from "./index.js";

describe("Ink TUI components", () => {
  it("renders the full TUI surface from event-derived state", () => {
    let state = createInitialTuiState({ ...defaultConfig, sources: [] });
    state = reduceTuiEvent(state, {
      schemaVersion: 1,
      id: "evt_1" as never,
      sessionId: "nx_test" as never,
      timestamp: "2026-05-20T00:00:00.000Z",
      type: "assistant.message",
      text: "Ready"
    });
    state = {
      ...state,
      lastDiff: "--- a/file.ts\n+++ b/file.ts\n-old\n+new",
      activeTools: ["file.write"],
      pendingLearningCandidates: 1
    };

    const app = render(<NexusTuiApp state={state} />);

    expect(app.lastFrame()).toContain("Transcript");
    expect(app.lastFrame()).toContain("Approval");
    expect(app.lastFrame()).toContain("Diff");
    expect(app.lastFrame()).toContain("Processes");
    expect(app.lastFrame()).toContain("Memory");
    expect(app.lastFrame()).toContain("Ready");
  });

  it("submits prompt text from the composer", async () => {
    const onSubmitPrompt = vi.fn();
    const app = render(
      <NexusTuiApp
        state={createInitialTuiState({ ...defaultConfig, sources: [] })}
        onSubmitPrompt={onSubmitPrompt}
      />
    );

    app.stdin.write("hello");
    await waitForInput();
    app.stdin.write("\r");
    await waitForInput();

    expect(onSubmitPrompt).toHaveBeenCalledWith("hello");
  });

  it("dispatches slash command intents from the composer", async () => {
    const onIntent = vi.fn<(intent: RuntimeIntent) => void>();
    const app = render(
      <NexusTuiApp
        state={createInitialTuiState({ ...defaultConfig, sources: [] })}
        onIntent={onIntent}
      />
    );

    app.stdin.write("/status");
    await waitForInput();
    app.stdin.write("\r");
    await waitForInput();

    expect(onIntent).toHaveBeenCalledWith({ type: "status.show" });
  });
});

async function waitForInput(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}
