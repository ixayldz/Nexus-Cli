import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpRegistry } from "./index.js";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("mcp registry", () => {
  it("adds, lists and removes local MCP servers", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "nexus-mcp-"));
    const registry = new McpRegistry();

    const added = await registry.add(tempDir, {
      id: "local",
      name: "Local MCP",
      transport: "stdio",
      command: "node",
      args: ["server.js"],
      enabled: true,
      permissions: ["workspace.read"]
    });

    expect(added.trust).toBe("untrusted");
    await expect(registry.list(tempDir)).resolves.toHaveLength(1);
    await expect(registry.remove(tempDir, "local")).resolves.toBe(true);
    await expect(registry.list(tempDir)).resolves.toEqual([]);
  });

  it("updates trust and tool allowlists", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "nexus-mcp-"));
    const registry = new McpRegistry();
    await registry.add(tempDir, {
      id: "local",
      name: "Local MCP",
      transport: "stdio",
      command: "node",
      args: ["server.js"],
      enabled: true,
      permissions: ["workspace.read"]
    });

    await expect(registry.update(tempDir, "local", { trust: "trusted" })).resolves.toMatchObject({
      id: "local",
      trust: "trusted"
    });
    await expect(registry.allowTool(tempDir, "local", "search")).resolves.toMatchObject({
      allowedTools: ["search"]
    });
    await expect(registry.denyTool(tempDir, "local", "search")).resolves.toMatchObject({
      allowedTools: []
    });
  });
});
