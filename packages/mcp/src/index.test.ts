import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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
      trust: "trusted",
      governance: { policyVersion: "nexus-mcp-v1" }
    });
    await expect(registry.allowTool(tempDir, "local", "search")).resolves.toMatchObject({
      allowedTools: ["search"]
    });
    await expect(registry.denyTool(tempDir, "local", "search")).resolves.toMatchObject({
      allowedTools: []
    });
  });

  it("stores governance and approved remote registries", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "nexus-mcp-"));
    const registry = new McpRegistry();

    await expect(registry.governance(tempDir)).resolves.toMatchObject({
      policyVersion: "nexus-mcp-v1",
      remoteRegistries: []
    });
    await expect(
      registry.addRemoteRegistry(tempDir, "https://registry.example.test/mcp")
    ).resolves.toMatchObject({
      remoteRegistries: ["https://registry.example.test/mcp"]
    });
    await expect(
      registry.add(tempDir, {
        id: "remote",
        name: "Remote MCP",
        transport: "http",
        url: "https://mcp.example.test/rpc",
        enabled: false,
        permissions: ["workspace.read"],
        source: "remote",
        registryUrl: "https://registry.example.test/mcp",
        manifest: { name: "Remote MCP", version: "1.0.0", toolCount: 1 }
      })
    ).resolves.toMatchObject({
      source: "remote",
      registryUrl: "https://registry.example.test/mcp",
      manifest: { name: "Remote MCP", version: "1.0.0" }
    });
  });

  it("rejects a symlinked MCP registry file before reading it", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "nexus-mcp-"));
    const external = await mkdtemp(join(tmpdir(), "nexus-mcp-external-"));
    try {
      await mkdir(join(tempDir, ".nexus"), { recursive: true });
      await writeFile(join(external, "mcp.json"), JSON.stringify({ servers: [] }), "utf8");
      try {
        await symlink(join(external, "mcp.json"), join(tempDir, ".nexus", "mcp.json"), "file");
      } catch {
        return;
      }

      await expect(new McpRegistry().list(tempDir)).rejects.toThrow(
        "Read target must not be a symlink"
      );
    } finally {
      await rm(external, { recursive: true, force: true });
    }
  });
});
