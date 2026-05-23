import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

export interface SkillManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  triggers: string[];
  files: string[];
  requiredTools?: string[];
  permissions?: string[];
}

export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  triggerCount: number;
}

export class SkillRegistry {
  public async list(cwd: string): Promise<SkillManifest[]> {
    const local = await readLocalSkills(cwd);
    return [...builtInSkills, ...local].sort((left, right) => left.id.localeCompare(right.id));
  }

  public async summaries(cwd: string): Promise<SkillSummary[]> {
    return (await this.list(cwd)).map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      triggerCount: skill.triggers.length
    }));
  }

  public async match(cwd: string, text: string): Promise<SkillManifest[]> {
    const query = text.toLowerCase();
    return (await this.list(cwd)).filter((skill) =>
      skill.triggers.some((trigger) => query.includes(trigger.toLowerCase()))
    );
  }

  public async contextSummary(cwd: string, skillId: string): Promise<string | undefined> {
    const skill = (await this.list(cwd)).find((item) => item.id === skillId);
    if (!skill) {
      return undefined;
    }
    return `${skill.name}: ${skill.description}`;
  }
}

const builtInSkills: SkillManifest[] = [
  {
    id: "code-review",
    name: "Code Review",
    description: "Review diffs for correctness, tests and maintainability.",
    version: "1.0.0",
    triggers: ["review", "diff", "finding"],
    files: [],
    requiredTools: ["git.diff"],
    permissions: ["workspace.read"]
  },
  {
    id: "security-audit",
    name: "Security Audit",
    description: "Inspect changes for secrets, risky commands and protected paths.",
    version: "1.0.0",
    triggers: ["security", "secret", "auth", "token"],
    files: [],
    requiredTools: ["search.files"],
    permissions: ["workspace.read"]
  }
];

async function readLocalSkills(cwd: string): Promise<SkillManifest[]> {
  await assertSafeNexusRoot(cwd);
  const directory = join(cwd, ".nexus", "skills");
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const manifests: SkillManifest[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const manifest = await readSkillManifest(join(directory, entry.name));
    if (manifest) {
      manifests.push(manifest);
    }
  }
  return manifests;
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
    throw new Error(".nexus skill registry must not be a symlink.");
  }
  const realNexusRoot = await realpath(nexusRoot).catch(() => nexusRoot);
  if (!isInside(realNexusRoot, realWorkspaceRoot)) {
    throw new Error(".nexus skill registry resolves outside the workspace.");
  }
}

function isInside(target: string, root: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

async function readSkillManifest(path: string): Promise<SkillManifest | undefined> {
  const content = await readFile(path, "utf8").catch(() => undefined);
  if (!content) {
    return undefined;
  }
  const parsed = JSON.parse(content) as Partial<SkillManifest>;
  if (
    typeof parsed.id === "string" &&
    typeof parsed.name === "string" &&
    typeof parsed.description === "string" &&
    typeof parsed.version === "string" &&
    Array.isArray(parsed.triggers) &&
    Array.isArray(parsed.files)
  ) {
    return {
      id: parsed.id,
      name: parsed.name,
      description: parsed.description,
      version: parsed.version,
      triggers: parsed.triggers.filter((item): item is string => typeof item === "string"),
      files: parsed.files.filter((item): item is string => typeof item === "string"),
      ...(Array.isArray(parsed.requiredTools)
        ? {
            requiredTools: parsed.requiredTools.filter(
              (item): item is string => typeof item === "string"
            )
          }
        : {}),
      ...(Array.isArray(parsed.permissions)
        ? {
            permissions: parsed.permissions.filter(
              (item): item is string => typeof item === "string"
            )
          }
        : {})
    };
  }
  return undefined;
}
