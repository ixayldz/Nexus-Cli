import { describe, expect, it } from "vitest";
import { SandboxManager, TypescriptSandboxAdapter } from "./index.js";

describe("sandbox manager", () => {
  it("prepares TypeScript-level sandbox context", async () => {
    const manager = new SandboxManager();
    await expect(
      manager.prepare({ mode: "workspace-write", platform: process.platform })
    ).resolves.toMatchObject({
      ok: true,
      context: { mode: "workspace-write", hardEnforced: false }
    });
  });

  it("fails closed when hard sandbox is required", async () => {
    const manager = new SandboxManager([new TypescriptSandboxAdapter()]);
    await expect(
      manager.prepare({
        mode: "workspace-write",
        platform: process.platform,
        requiresHardSandbox: true
      })
    ).resolves.toMatchObject({ ok: false });
  });

  it("reports sandbox doctor capabilities", async () => {
    const manager = new SandboxManager();
    await expect(manager.doctor(process.platform)).resolves.toContain("Sandbox doctor");
  });
});
