import { execFile } from "node:child_process";
import { type SandboxMode } from "@nexus/shared";

export type SandboxRuntimeId = "typescript" | "docker" | "podman";
export type SandboxPreferredAdapter = "auto" | SandboxRuntimeId;
export type SandboxNetworkMode = "none" | "host";
export type SandboxMountMode = "read-only" | "workspace-write";

export interface SandboxContainerConfig {
  runtime?: "auto" | "docker" | "podman";
  image?: string;
  network?: SandboxNetworkMode;
  envAllowlist?: string[];
  timeoutMs?: number;
  memoryLimitMb?: number;
  cpuLimit?: number;
}

export interface SandboxRuntimeConfig {
  preferredAdapter?: SandboxPreferredAdapter;
  container?: SandboxContainerConfig;
}

export interface SandboxPrepareInput {
  mode: SandboxMode;
  platform: NodeJS.Platform;
  requiresHardSandbox?: boolean;
  cwd?: string;
  config?: SandboxRuntimeConfig;
}

export interface SandboxContext {
  mode: SandboxMode;
  adapterId: string;
  hardEnforced: boolean;
  runtime?: SandboxRuntimeId;
  image?: string;
  workspacePath?: string;
  mountMode?: SandboxMountMode;
  network?: SandboxNetworkMode;
  envAllowlist?: string[];
  timeoutMs?: number;
  memoryLimitMb?: number;
  cpuLimit?: number;
}

export interface SandboxCapability {
  id: SandboxRuntimeId;
  available: boolean;
  hardEnforced: boolean;
  reason?: string;
}

export interface SandboxAdapter {
  id: string;
  supports(mode: SandboxMode, platform: NodeJS.Platform): boolean;
  prepare(input: SandboxPrepareInput): Promise<SandboxContext>;
}

export class TypescriptSandboxAdapter implements SandboxAdapter {
  public readonly id = "typescript-guard";

  public supports(mode: SandboxMode): boolean {
    return mode === "read-only" || mode === "workspace-write" || mode === "danger-full-access";
  }

  public async prepare(input: SandboxPrepareInput): Promise<SandboxContext> {
    return {
      mode: input.mode,
      adapterId: this.id,
      hardEnforced: false,
      runtime: "typescript"
    };
  }
}

export class ContainerSandboxAdapter implements SandboxAdapter {
  public readonly id = "container";

  public supports(mode: SandboxMode): boolean {
    return mode === "read-only" || mode === "workspace-write" || mode === "danger-full-access";
  }

  public async prepare(input: SandboxPrepareInput): Promise<SandboxContext> {
    const runtime = await resolveContainerRuntime(input.config);
    if (!runtime) {
      throw new Error("Docker or Podman is required for hard sandbox enforcement but was not available.");
    }

    const container = input.config?.container ?? {};
    const mountMode: SandboxMountMode = input.mode === "read-only" ? "read-only" : "workspace-write";
    const image = container.image ?? "node:22-bookworm-slim";
    const network = container.network ?? "none";
    return {
      mode: input.mode,
      adapterId: this.id,
      hardEnforced: true,
      runtime,
      image,
      workspacePath: input.cwd ?? process.cwd(),
      mountMode,
      network,
      envAllowlist: container.envAllowlist ?? ["PATH", "HOME", "USERPROFILE", "TMP", "TEMP"],
      timeoutMs: container.timeoutMs ?? 300000,
      ...(container.memoryLimitMb !== undefined ? { memoryLimitMb: container.memoryLimitMb } : {}),
      ...(container.cpuLimit !== undefined ? { cpuLimit: container.cpuLimit } : {})
    };
  }
}

export interface SandboxResolution {
  ok: boolean;
  context?: SandboxContext;
  reason?: string;
}

export class SandboxManager {
  public constructor(
    private readonly adapters: SandboxAdapter[] = [new ContainerSandboxAdapter(), new TypescriptSandboxAdapter()]
  ) {}

  public async prepare(input: SandboxPrepareInput): Promise<SandboxResolution> {
    if (input.requiresHardSandbox) {
      const adapter = this.adapters.find((candidate) => candidate.id === "container" && candidate.supports(input.mode, input.platform));
      if (!adapter) {
        return {
          ok: false,
          reason: "Hard sandbox enforcement was required, but no hard sandbox adapter is configured."
        };
      }
      try {
        return {
          ok: true,
          context: await adapter.prepare(input)
        };
      } catch (error) {
        return {
          ok: false,
          reason: error instanceof Error ? error.message : String(error)
        };
      }
    }

    const preferred = input.config?.preferredAdapter;
    const adapter =
      preferred && preferred !== "auto"
        ? this.adapters.find((candidate) => adapterMatchesPreferred(candidate, preferred) && candidate.supports(input.mode, input.platform))
        : this.adapters.find((candidate) => candidate.id === "typescript-guard" && candidate.supports(input.mode, input.platform)) ??
          this.adapters.find((candidate) => candidate.supports(input.mode, input.platform));
    if (!adapter) {
      return {
        ok: false,
        reason: `No sandbox adapter supports mode '${input.mode}' on ${input.platform}.`
      };
    }

    return {
      ok: true,
      context: await adapter.prepare(input)
    };
  }

  public async listCapabilities(): Promise<SandboxCapability[]> {
    const docker = await commandAvailable("docker");
    const podman = await commandAvailable("podman");
    return [
      { id: "typescript", available: true, hardEnforced: false, reason: "Policy guard only; no kernel/container isolation." },
      {
        id: "docker",
        available: docker,
        hardEnforced: docker,
        ...(docker ? {} : { reason: "docker --version failed or docker is not on PATH." })
      },
      {
        id: "podman",
        available: podman,
        hardEnforced: podman,
        ...(podman ? {} : { reason: "podman --version failed or podman is not on PATH." })
      }
    ];
  }

  public async doctor(platform: NodeJS.Platform = process.platform): Promise<string> {
    const capabilities = await this.listCapabilities();
    const hard = capabilities.filter((capability) => capability.hardEnforced);
    const lines = [
      "Sandbox doctor",
      `Platform: ${platform}`,
      `Hard sandbox available: ${hard.length > 0 ? hard.map((capability) => capability.id).join(", ") : "no"}`,
      ...capabilities.map((capability) => {
        const status = capability.available ? "available" : "missing";
        const hardStatus = capability.hardEnforced ? "hard" : "soft";
        return `- ${capability.id}: ${status}, ${hardStatus}${capability.reason ? ` (${capability.reason})` : ""}`;
      })
    ];
    return lines.join("\n");
  }
}

function adapterMatchesPreferred(adapter: SandboxAdapter, preferred: SandboxRuntimeId): boolean {
  if (preferred === "typescript") {
    return adapter.id === "typescript-guard";
  }
  return adapter.id === "container";
}

async function resolveContainerRuntime(config: SandboxRuntimeConfig | undefined): Promise<"docker" | "podman" | undefined> {
  const preferred = config?.container?.runtime ?? (config?.preferredAdapter === "docker" || config?.preferredAdapter === "podman" ? config.preferredAdapter : "auto");
  if (preferred === "docker" || preferred === "podman") {
    return (await commandAvailable(preferred)) ? preferred : undefined;
  }
  if (await commandAvailable("docker")) {
    return "docker";
  }
  if (await commandAvailable("podman")) {
    return "podman";
  }
  return undefined;
}

async function commandAvailable(command: "docker" | "podman"): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const child = execFile(command, ["--version"], { timeout: 2000, windowsHide: true }, (error) => {
      resolvePromise(!error);
    });
    child.on("error", () => {
      resolvePromise(false);
    });
  });
}
