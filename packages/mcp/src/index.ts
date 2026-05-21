import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { safeJsonStringify } from "@nexus/shared";

export interface McpServerConfig {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  enabled: boolean;
  permissions: string[];
  trust?: "untrusted" | "trusted";
  allowedTools?: string[];
  envAllowlist?: string[];
  pinnedCommandSha256?: string;
}

export interface McpToolManifest {
  serverId: string;
  tools: Array<{ name: string; description: string; inputSchema?: unknown }>;
}

export interface McpToolAdapter {
  serverId: string;
  mcpToolName: string;
  name: string;
  description: string;
}

export class McpRegistry {
  public async list(cwd: string): Promise<McpServerConfig[]> {
    const store = await readStore(cwd);
    return store.servers.sort((left, right) => left.id.localeCompare(right.id));
  }

  public async add(cwd: string, server: McpServerConfig): Promise<McpServerConfig> {
    const normalized = normalizeServer(server);
    validateServer(normalized);
    const store = await readStore(cwd);
    const next = {
      servers: [...store.servers.filter((item) => item.id !== normalized.id), normalized]
    };
    await writeStore(cwd, next);
    return normalized;
  }

  public async remove(cwd: string, serverId: string): Promise<boolean> {
    const store = await readStore(cwd);
    const nextServers = store.servers.filter((item) => item.id !== serverId);
    await writeStore(cwd, { servers: nextServers });
    return nextServers.length !== store.servers.length;
  }

  public async update(
    cwd: string,
    serverId: string,
    patch: Partial<Pick<McpServerConfig, "enabled" | "trust" | "allowedTools" | "envAllowlist" | "permissions">>
  ): Promise<McpServerConfig | undefined> {
    const store = await readStore(cwd);
    const existing = store.servers.find((server) => server.id === serverId);
    if (!existing) {
      return undefined;
    }
    const updated = normalizeServer({
      ...existing,
      ...patch
    });
    validateServer(updated);
    await writeStore(cwd, {
      servers: store.servers.map((server) => (server.id === serverId ? updated : server))
    });
    return updated;
  }

  public async allowTool(cwd: string, serverId: string, toolName: string): Promise<McpServerConfig | undefined> {
    const store = await readStore(cwd);
    const existing = store.servers.find((server) => server.id === serverId);
    if (!existing) {
      return undefined;
    }
    return this.update(cwd, serverId, {
      allowedTools: [...new Set([...(existing.allowedTools ?? []), toolName])].sort()
    });
  }

  public async denyTool(cwd: string, serverId: string, toolName: string): Promise<McpServerConfig | undefined> {
    const store = await readStore(cwd);
    const existing = store.servers.find((server) => server.id === serverId);
    if (!existing) {
      return undefined;
    }
    return this.update(cwd, serverId, {
      allowedTools: (existing.allowedTools ?? []).filter((tool) => tool !== toolName)
    });
  }

  public async listToolAdapters(cwd: string, manifests: McpToolManifest[] = []): Promise<McpToolAdapter[]> {
    const servers = new Set((await this.list(cwd)).filter((server) => server.enabled).map((server) => server.id));
    return manifests
      .filter((manifest) => servers.has(manifest.serverId))
      .flatMap((manifest) =>
        manifest.tools.map((tool) => ({
          serverId: manifest.serverId,
          mcpToolName: tool.name,
          name: `mcp.${manifest.serverId}.${tool.name}`,
          description: tool.description
        }))
      );
  }
}

interface McpStore {
  servers: McpServerConfig[];
}

function registryPath(cwd: string): string {
  return join(cwd, ".nexus", "mcp.json");
}

async function readStore(cwd: string): Promise<McpStore> {
  await assertSafeNexusRoot(cwd);
  const content = await readFile(registryPath(cwd), "utf8").catch(() => undefined);
  if (!content) {
    return { servers: [] };
  }
  const parsed = JSON.parse(content) as Partial<McpStore>;
  return {
    servers: Array.isArray(parsed.servers) ? parsed.servers.filter(isServer) : []
  };
}

async function writeStore(cwd: string, store: McpStore): Promise<void> {
  await assertSafeNexusRoot(cwd);
  const path = registryPath(cwd);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${safeJsonStringify(store)}\n`, "utf8");
}

async function assertSafeNexusRoot(cwd: string): Promise<void> {
  const workspaceRoot = resolve(cwd);
  const realWorkspaceRoot = await realpath(workspaceRoot).catch(() => workspaceRoot);
  const nexusRoot = join(workspaceRoot, ".nexus");
  const metadata = await lstat(nexusRoot).catch(() => undefined);
  if (!metadata) {
    return;
  }
  if (metadata.isSymbolicLink()) {
    throw new Error(".nexus MCP registry must not be a symlink.");
  }
  const realNexusRoot = await realpath(nexusRoot).catch(() => nexusRoot);
  if (!isInside(realNexusRoot, realWorkspaceRoot)) {
    throw new Error(".nexus MCP registry resolves outside the workspace.");
  }
}

function isInside(target: string, root: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function validateServer(server: McpServerConfig): void {
  if (!server.id || !/^[a-z0-9_-]+$/i.test(server.id)) {
    throw new Error("MCP server id must be a non-empty slug.");
  }
  if (server.transport === "stdio" && !server.command) {
    throw new Error("stdio MCP servers require a command.");
  }
  if (server.transport === "http" && !server.url) {
    throw new Error("http MCP servers require a url.");
  }
  if (server.trust !== "untrusted" && server.trust !== "trusted") {
    throw new Error("MCP server trust must be 'untrusted' or 'trusted'.");
  }
  if (server.allowedTools?.some((tool) => !/^[a-z0-9_.-]+$/i.test(tool))) {
    throw new Error("MCP allowed tool names must be slugs.");
  }
}

function normalizeServer(server: McpServerConfig): McpServerConfig {
  return {
    ...server,
    permissions: [...new Set(server.permissions)].sort(),
    trust: server.trust ?? "untrusted",
    allowedTools: server.allowedTools ?? [],
    envAllowlist: server.envAllowlist ?? []
  };
}

function isServer(value: unknown): value is McpServerConfig {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const item = value as Partial<McpServerConfig>;
  return (
    typeof item.id === "string" &&
    typeof item.name === "string" &&
    (item.transport === "stdio" || item.transport === "http") &&
    typeof item.enabled === "boolean" &&
    Array.isArray(item.permissions) &&
    (item.trust === undefined || item.trust === "untrusted" || item.trust === "trusted") &&
    (item.allowedTools === undefined || item.allowedTools.every((tool) => typeof tool === "string")) &&
    (item.envAllowlist === undefined || item.envAllowlist.every((key) => typeof key === "string")) &&
    (item.pinnedCommandSha256 === undefined || typeof item.pinnedCommandSha256 === "string")
  );
}
