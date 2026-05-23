import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { nowIso, safeJsonStringify } from "@nexus/shared";
import { safeAtomicWriteText, safeReadTextFile } from "@nexus/storage";

export const MCP_GOVERNANCE_POLICY_VERSION = "nexus-mcp-v1";

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
  source?: "local" | "remote";
  registryUrl?: string;
  manifest?: McpServerManifest;
  governance?: McpServerGovernance;
}

export interface McpServerManifest {
  name: string;
  version?: string;
  homepage?: string;
  toolCount?: number;
}

export interface McpServerGovernance {
  policyVersion: string;
  reviewedAt: string;
  reviewedBy?: string;
  notes?: string;
}

export interface McpRegistryGovernance {
  schemaVersion: 1;
  policyVersion: string;
  remoteRegistries: string[];
  updatedAt: string;
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

  public async governance(cwd: string): Promise<McpRegistryGovernance> {
    return (await readStore(cwd)).governance;
  }

  public async addRemoteRegistry(cwd: string, url: string): Promise<McpRegistryGovernance> {
    validateRegistryUrl(url);
    const store = await readStore(cwd);
    const governance = normalizeGovernance({
      ...store.governance,
      remoteRegistries: [...new Set([...store.governance.remoteRegistries, url])].sort(),
      updatedAt: nowIso()
    });
    await writeStore(cwd, { ...store, governance });
    return governance;
  }

  public async add(cwd: string, server: McpServerConfig): Promise<McpServerConfig> {
    const normalized = await normalizeServer(cwd, server);
    validateServer(normalized);
    const store = await readStore(cwd);
    const next = {
      governance: store.governance,
      servers: [...store.servers.filter((item) => item.id !== normalized.id), normalized]
    };
    await writeStore(cwd, next);
    return normalized;
  }

  public async remove(cwd: string, serverId: string): Promise<boolean> {
    const store = await readStore(cwd);
    const nextServers = store.servers.filter((item) => item.id !== serverId);
    await writeStore(cwd, { governance: store.governance, servers: nextServers });
    return nextServers.length !== store.servers.length;
  }

  public async update(
    cwd: string,
    serverId: string,
    patch: Partial<
      Pick<McpServerConfig, "enabled" | "trust" | "allowedTools" | "envAllowlist" | "permissions">
    >
  ): Promise<McpServerConfig | undefined> {
    const store = await readStore(cwd);
    const existing = store.servers.find((server) => server.id === serverId);
    if (!existing) {
      return undefined;
    }
    const updated = await normalizeServer(cwd, {
      ...existing,
      ...patch,
      ...(patch.trust === "trusted"
        ? {
            governance: existing.governance ?? {
              policyVersion: MCP_GOVERNANCE_POLICY_VERSION,
              reviewedAt: nowIso()
            }
          }
        : {})
    });
    validateServer(updated);
    await writeStore(cwd, {
      governance: store.governance,
      servers: store.servers.map((server) => (server.id === serverId ? updated : server))
    });
    return updated;
  }

  public async allowTool(
    cwd: string,
    serverId: string,
    toolName: string
  ): Promise<McpServerConfig | undefined> {
    const store = await readStore(cwd);
    const existing = store.servers.find((server) => server.id === serverId);
    if (!existing) {
      return undefined;
    }
    return this.update(cwd, serverId, {
      allowedTools: [...new Set([...(existing.allowedTools ?? []), toolName])].sort()
    });
  }

  public async denyTool(
    cwd: string,
    serverId: string,
    toolName: string
  ): Promise<McpServerConfig | undefined> {
    const store = await readStore(cwd);
    const existing = store.servers.find((server) => server.id === serverId);
    if (!existing) {
      return undefined;
    }
    return this.update(cwd, serverId, {
      allowedTools: (existing.allowedTools ?? []).filter((tool) => tool !== toolName)
    });
  }

  public async listToolAdapters(
    cwd: string,
    manifests: McpToolManifest[] = []
  ): Promise<McpToolAdapter[]> {
    const servers = new Set(
      (await this.list(cwd)).filter((server) => server.enabled).map((server) => server.id)
    );
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
  governance: McpRegistryGovernance;
  servers: McpServerConfig[];
}

function registryPath(cwd: string): string {
  return join(cwd, ".nexus", "mcp.json");
}

async function readStore(cwd: string): Promise<McpStore> {
  await assertSafeNexusRoot(cwd);
  const content = await safeReadTextFile({
    path: registryPath(cwd),
    allowedRoot: join(cwd, ".nexus"),
    workspaceRoot: cwd,
    rootDescription: ".nexus MCP registry"
  });
  if (!content) {
    return { governance: defaultGovernance(), servers: [] };
  }
  const parsed = JSON.parse(content) as Partial<McpStore>;
  return {
    governance: normalizeGovernance(parsed.governance),
    servers: Array.isArray(parsed.servers) ? parsed.servers.filter(isServer) : []
  };
}

async function writeStore(cwd: string, store: McpStore): Promise<void> {
  await assertSafeNexusRoot(cwd);
  const path = registryPath(cwd);
  await safeAtomicWriteText({
    path,
    allowedRoot: dirname(path),
    workspaceRoot: cwd,
    content: `${safeJsonStringify(store)}\n`,
    rootDescription: ".nexus MCP registry"
  });
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
  if (server.source === "remote" && !server.registryUrl) {
    throw new Error("Remote MCP servers require a registryUrl.");
  }
  if (server.registryUrl) {
    validateRegistryUrl(server.registryUrl);
  }
  if (server.governance && server.governance.policyVersion !== MCP_GOVERNANCE_POLICY_VERSION) {
    throw new Error(`MCP governance policy must be '${MCP_GOVERNANCE_POLICY_VERSION}'.`);
  }
}

async function normalizeServer(cwd: string, server: McpServerConfig): Promise<McpServerConfig> {
  const normalized: McpServerConfig = {
    ...server,
    permissions: [...new Set(server.permissions)].sort(),
    trust: server.trust ?? "untrusted",
    allowedTools: server.allowedTools ?? [],
    envAllowlist: server.envAllowlist ?? [],
    source: server.source ?? "local"
  };
  if (normalized.transport === "stdio" && !normalized.pinnedCommandSha256) {
    const pinnedCommandSha256 = await fingerprintServerCommand(cwd, normalized);
    if (pinnedCommandSha256) {
      normalized.pinnedCommandSha256 = pinnedCommandSha256;
    }
  }
  if (!normalized.manifest) {
    normalized.manifest = { name: normalized.name };
  }
  return normalized;
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
    (item.allowedTools === undefined ||
      item.allowedTools.every((tool) => typeof tool === "string")) &&
    (item.envAllowlist === undefined ||
      item.envAllowlist.every((key) => typeof key === "string")) &&
    (item.pinnedCommandSha256 === undefined || typeof item.pinnedCommandSha256 === "string") &&
    (item.source === undefined || item.source === "local" || item.source === "remote") &&
    (item.registryUrl === undefined || typeof item.registryUrl === "string") &&
    (item.manifest === undefined || isManifest(item.manifest)) &&
    (item.governance === undefined || isGovernance(item.governance))
  );
}

function defaultGovernance(): McpRegistryGovernance {
  return {
    schemaVersion: 1,
    policyVersion: MCP_GOVERNANCE_POLICY_VERSION,
    remoteRegistries: [],
    updatedAt: nowIso()
  };
}

function normalizeGovernance(value: unknown): McpRegistryGovernance {
  if (typeof value !== "object" || value === null) {
    return defaultGovernance();
  }
  const item = value as Partial<McpRegistryGovernance>;
  return {
    schemaVersion: 1,
    policyVersion:
      item.policyVersion === MCP_GOVERNANCE_POLICY_VERSION
        ? item.policyVersion
        : MCP_GOVERNANCE_POLICY_VERSION,
    remoteRegistries: Array.isArray(item.remoteRegistries)
      ? item.remoteRegistries.filter((url) => typeof url === "string").sort()
      : [],
    updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : nowIso()
  };
}

function isManifest(value: unknown): value is McpServerManifest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const item = value as Partial<McpServerManifest>;
  return (
    typeof item.name === "string" &&
    (item.version === undefined || typeof item.version === "string") &&
    (item.homepage === undefined || typeof item.homepage === "string") &&
    (item.toolCount === undefined || typeof item.toolCount === "number")
  );
}

function isGovernance(value: unknown): value is McpServerGovernance {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const item = value as Partial<McpServerGovernance>;
  return (
    typeof item.policyVersion === "string" &&
    typeof item.reviewedAt === "string" &&
    (item.reviewedBy === undefined || typeof item.reviewedBy === "string") &&
    (item.notes === undefined || typeof item.notes === "string")
  );
}

async function fingerprintServerCommand(
  cwd: string,
  server: McpServerConfig
): Promise<string | undefined> {
  const candidates = [
    server.command,
    ...(isNodeLikeCommand(server.command) && server.args?.[0] ? [server.args[0]] : [])
  ];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const absolutePath = isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
    const content = await readFile(absolutePath).catch(() => undefined);
    if (content) {
      return createHash("sha256").update(content).digest("hex");
    }
  }
  return undefined;
}

function isNodeLikeCommand(command: string | undefined): boolean {
  return Boolean(command && /(?:^|[/\\])(?:node|node\.exe|bun|bun\.exe)$/.test(command));
}

function validateRegistryUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("MCP registry URL must be a valid URL.");
  }
  if (
    parsed.protocol !== "https:" &&
    parsed.hostname !== "localhost" &&
    parsed.hostname !== "127.0.0.1"
  ) {
    throw new Error("MCP registry URL must use https unless it targets localhost.");
  }
}
