import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentSummary, InstalledSkill } from "@dani-dex/contracts/ipc";
import { isDynamicRecord } from "@dani-dex/contracts/runtime-values";
import { createDaniDexLogger, toLogValue } from "@dani-dex/logging";
import { parse as parseYaml } from "yaml";

const MANAGED_SKILL_SLUG = "dani-dex-site-hosting";
const OWNERSHIP_MARKER = ".dani-dex-managed.json";

const logger = createDaniDexLogger("managed-skill-service");

export interface SyncTargetsResult {
  collisions: string[];
  failures: { target: string; error: unknown }[];
}

export class ManagedSkillService {
  #content: string | null = null;

  constructor(
    private readonly sourcePath: string,
    private readonly reportCollision: (target: string) => void = (target) => {
      logger.warn(`Dani-Dex preserved an unowned managed-skill collision at ${target}.`);
    },
    private readonly reportFailure: (target: string, error: unknown) => void = (target, error) => {
      logger.error(`Dani-Dex could not synchronize the managed skill at ${target}.`, toLogValue(error));
    },
    private readonly slug = MANAGED_SKILL_SLUG,
  ) {}

  async syncAll(agents: AgentSummary[]): Promise<void> {
    let content: string;
    try {
      content = await this.content();
    } catch (error) {
      this.reportFailure(this.sourcePath, error);
      return;
    }
    const results = await Promise.allSettled(
      agents.map((agent) => syncTargets(agent.workspacePath, content, this.slug)),
    );
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (result.status === "fulfilled") {
        this.reportResult(result.value);
      } else {
        this.reportFailure(agents[index]?.workspacePath ?? "unknown workspace", result.reason);
      }
    }
  }

  async syncAgent(agent: AgentSummary): Promise<void> {
    try {
      this.reportResult(await syncTargets(agent.workspacePath, await this.content(), this.slug));
    } catch (error) {
      this.reportFailure(agent.workspacePath, error);
    }
  }

  private async content(): Promise<string> {
    if (this.#content !== null) return this.#content;
    const content = await readFile(this.sourcePath, "utf8");
    if (!content.startsWith(`---\nname: ${this.slug}\n`)) {
      throw new Error("The managed site hosting skill is invalid.");
    }
    this.#content = content;
    return content;
  }

  private reportResult(result: SyncTargetsResult): void {
    for (const target of result.collisions) this.reportCollision(target);
    for (const failure of result.failures) this.reportFailure(failure.target, failure.error);
  }
}

async function syncTargets(workspacePath: string, content: string, slug: string): Promise<SyncTargetsResult> {
  const workspaceRoot = await realpath(resolve(workspacePath));
  if (await fileExists(join(workspaceRoot, ".dani-dex-disabled-skills", slug, "SKILL.md"))) {
    await reconcileDisabledSkill(workspaceRoot, slug);
    return { collisions: [], failures: [] };
  }
  const targets = [
    join(workspacePath, ".agents", "skills", slug, "SKILL.md"),
    join(workspacePath, ".claude", "skills", slug, "SKILL.md"),
  ];
  const resolvedTargets = [
    join(workspaceRoot, ".agents", "skills", slug, "SKILL.md"),
    join(workspaceRoot, ".claude", "skills", slug, "SKILL.md"),
  ];
  const results = await Promise.allSettled(
    resolvedTargets.map((target) => syncTarget(workspaceRoot, target, content, slug)),
  );
  const collisions: string[] = [];
  const failures: SyncTargetsResult["failures"] = [];
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    const target = targets[index];
    if (!result || !target) continue;
    if (result.status === "rejected") failures.push({ target, error: result.reason });
    else if (result.value === "collision") collisions.push(target);
  }
  return { collisions, failures };
}

async function syncTarget(
  workspaceRoot: string,
  target: string,
  content: string,
  slug: string,
): Promise<"synced" | "collision"> {
  const ownershipContent = `${JSON.stringify({ managedBy: "danidex", slug, version: 1 })}\n`;
  const parent = dirname(target);
  await ensureSafeDirectory(workspaceRoot, parent);
  const marker = join(parent, OWNERSHIP_MARKER);
  await rejectSymlink(target);
  await rejectSymlink(marker);
  if (await fileExists(target)) {
    if ((await optionalText(marker)) !== ownershipContent) return "collision";
    await atomicWrite(workspaceRoot, target, content);
    return "synced";
  }
  try {
    await verifySafeDirectory(workspaceRoot, parent);
    await writeFile(target, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if (isFileExistsError(error)) return "collision";
    throw error;
  }
  try {
    await atomicWrite(workspaceRoot, marker, ownershipContent);
  } catch (error) {
    await verifySafeDirectory(workspaceRoot, parent)
      .then(() => unlink(target))
      .catch(() => undefined);
    throw error;
  }
  return "synced";
}

async function atomicWrite(workspaceRoot: string, target: string, content: string): Promise<void> {
  const parent = dirname(target);
  await verifySafeDirectory(workspaceRoot, parent);
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  try {
    await verifySafeDirectory(workspaceRoot, parent);
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function ensureSafeDirectory(workspaceRoot: string, directory: string): Promise<void> {
  const path = containedRelativePath(workspaceRoot, directory);
  let current = workspaceRoot;
  for (const segment of path.split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!isFileExistsError(error)) throw error;
    }
    await requireRealDirectory(current);
  }
  await verifySafeDirectory(workspaceRoot, directory);
}

async function verifySafeDirectory(workspaceRoot: string, directory: string): Promise<void> {
  const path = containedRelativePath(workspaceRoot, directory);
  await requireRealDirectory(workspaceRoot);
  let current = workspaceRoot;
  for (const segment of path.split(sep).filter(Boolean)) {
    current = join(current, segment);
    await requireRealDirectory(current);
  }
  const resolvedDirectory = await realpath(directory);
  if (!isInside(workspaceRoot, resolvedDirectory)) {
    throw new Error(`Managed skill target escapes its workspace: ${directory}`);
  }
}

function containedRelativePath(workspaceRoot: string, candidate: string): string {
  const path = relative(workspaceRoot, candidate);
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error(`Managed skill target escapes its workspace: ${candidate}`);
  }
  return path;
}

async function requireRealDirectory(path: string): Promise<void> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Managed skill path must be a real directory: ${path}`);
  }
}

async function rejectSymlink(path: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error(`Managed skill path cannot be a symlink: ${path}`);
  } catch (error) {
    if (isMissingFileError(error)) return;
    throw error;
  }
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

async function optionalText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isFileExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

/** Read only Dani-Dex-owned skills from the active provider's skill folder. */
export async function listManagedSkillsForChat(
  agent: Pick<AgentSummary, "workspacePath" | "provider">,
): Promise<InstalledSkill[]> {
  const root = await realpath(agent.workspacePath);
  const directory = join(root, agent.provider === "claude" ? ".claude" : ".agents", "skills");
  const directories = [directory, join(root, ".dani-dex-disabled-skills")];
  const skills: InstalledSkill[] = [];
  try {
    for (const directory of directories) {
      if (!(await fileExists(directory))) continue;
      await verifySafeDirectory(root, directory);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        try {
          const folder = join(directory, entry.name);
          await verifySafeDirectory(root, folder);
          const marker = join(folder, OWNERSHIP_MARKER);
          const file = join(folder, "SKILL.md");
          await rejectSymlink(marker);
          await rejectSymlink(file);
          if (
            (await optionalText(marker)) !==
            `${JSON.stringify({ managedBy: "danidex", slug: entry.name, version: 1 })}\n`
          )
            continue;
          const content = await readFile(file, "utf8");
          const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content)?.[1];
          if (!frontmatter) continue;
          const metadata = parseYaml(frontmatter);
          if (
            !isDynamicRecord(metadata) ||
            typeof metadata.name !== "string" ||
            !metadata.name.trim() ||
            typeof metadata.description !== "string"
          )
            continue;
          skills.push({
            skillId: entry.name,
            slug: entry.name,
            name: managedSkillName(entry.name, metadata.name),
            description: metadata.description,
            installedVersion: 1,
            availableVersion: 1,
            enabled: directory === directories[0],
            disableModelInvocation: metadata["disable-model-invocation"] === true,
            state: "installed",
            origin: "managed",
          });
        } catch {
          /* Missing or invalid managed files are not selectable. */
        }
      }
    }
  } catch {
    /* The workspace can have no managed skills yet. */
  }
  return skills;
}

export interface ManagedSkillFile {
  /** Relative to the skill folder, e.g. `SKILL.md` or `references/plan.md`. */
  path: string;
  content: string;
  executable?: boolean;
}

/**
 * Writes one Dani-Dex-owned skill, with any files beside its SKILL.md, into a workspace's
 * `.agents/skills` and `.claude/skills`. A folder the user made under the same name is left alone
 * and reported as a collision, exactly as for the single-file managed skills.
 */
export async function syncManagedSkillFiles(
  workspacePath: string,
  slug: string,
  files: readonly ManagedSkillFile[],
): Promise<SyncTargetsResult> {
  const skill = files.find((file) => file.path === "SKILL.md");
  if (!skill) throw new Error(`The ${slug} skill has no SKILL.md.`);
  const extras = files.filter((file) => file !== skill);
  const workspaceRoot = await realpath(resolve(workspacePath));
  if (await fileExists(join(workspaceRoot, ".dani-dex-disabled-skills", slug, "SKILL.md"))) {
    await reconcileDisabledSkill(workspaceRoot, slug);
    return { collisions: [], failures: [] };
  }
  const collisions: string[] = [];
  const failures: SyncTargetsResult["failures"] = [];
  for (const folder of [".agents", ".claude"]) {
    const target = join(workspaceRoot, folder, "skills", slug, "SKILL.md");
    try {
      if ((await syncTarget(workspaceRoot, target, skill.content, slug)) === "collision") {
        collisions.push(target);
        continue;
      }
      for (const extra of extras) {
        const path = join(dirname(target), extra.path);
        containedRelativePath(dirname(target), path);
        await ensureSafeDirectory(workspaceRoot, dirname(path));
        await rejectSymlink(path);
        await atomicWrite(workspaceRoot, path, extra.content);
        if (extra.executable) await chmod(path, 0o700);
      }
    } catch (error) {
      failures.push({ target, error });
    }
  }
  return { collisions, failures };
}

/**
 * Copies a scaffold into the workspace, one file at a time, never replacing a file that is already
 * there: the scaffold is a starting point the bot and the user go on to edit.
 */
export async function seedWorkspaceFiles(workspacePath: string, files: readonly ManagedSkillFile[]): Promise<void> {
  const workspaceRoot = await realpath(resolve(workspacePath));
  for (const file of files) {
    const path = join(workspaceRoot, file.path);
    containedRelativePath(workspaceRoot, path);
    await ensureSafeDirectory(workspaceRoot, dirname(path));
    await rejectSymlink(path);
    try {
      await writeFile(path, file.content, { encoding: "utf8", mode: file.executable ? 0o700 : 0o600, flag: "wx" });
    } catch (error) {
      if (!isFileExistsError(error)) throw error;
    }
  }
}

/** Explicit owner control. Preserve the whole owned bundle while providers cannot discover it. */
export async function setManagedSkillEnabled(
  agent: Pick<AgentSummary, "workspacePath" | "provider">,
  slug: string,
  enabled: boolean,
): Promise<InstalledSkill> {
  if (!/^[a-zA-Z0-9_-]+$/.test(slug)) throw new Error("Invalid built-in skill ID.");
  const skill = (await listManagedSkillsForChat(agent)).find((s) => s.slug === slug);
  if (!skill) throw new Error("Built-in skill not found.");
  if (skill.enabled === enabled) {
    if (!enabled) await reconcileDisabledSkill(await realpath(agent.workspacePath), slug);
    return skill;
  }
  const root = await realpath(agent.workspacePath);
  const stash = join(root, ".dani-dex-disabled-skills", slug);
  const targets = [join(root, ".agents", "skills", slug), join(root, ".claude", "skills", slug)];
  const marker = `${JSON.stringify({ managedBy: "danidex", slug, version: 1 })}\n`;
  for (const path of enabled ? [stash] : targets) {
    if (!(await fileExists(path))) continue;
    await verifySafeDirectory(root, path);
    await inspectOwnedTree(root, path);
    await rejectSymlink(join(path, OWNERSHIP_MARKER));
    if ((await optionalText(join(path, OWNERSHIP_MARKER))) !== marker)
      throw new Error("Unowned skill copy cannot be changed.");
  }
  if (enabled) {
    await reconcileDisabledSkill(root, slug);
    for (const path of targets) if (await fileExists(path)) throw new Error("Skill folder is occupied.");
    const { cp } = await import("node:fs/promises");
    const restored: string[] = [];
    try {
      for (const target of targets) {
        await ensureSafeDirectory(root, dirname(target));
        restored.push(target);
        await cp(stash, target, { recursive: true, errorOnExist: true, force: false });
      }
    } catch (error) {
      const { rm } = await import("node:fs/promises");
      for (const path of restored) await rm(path, { recursive: true });
      throw error;
    }
    const { rm } = await import("node:fs/promises");
    await rm(stash, { recursive: true });
  } else {
    const { cp, rm } = await import("node:fs/promises");
    const source = join(root, agent.provider === "claude" ? ".claude" : ".agents", "skills", slug);
    const sourceHash = await inspectOwnedTree(root, source);
    for (const target of targets)
      if ((await fileExists(target)) && (await inspectOwnedTree(root, target)) !== sourceHash)
        throw new Error("Provider copies differ. Reconcile local changes before disabling.");
    await ensureSafeDirectory(root, dirname(stash));
    if (await fileExists(stash)) throw new Error("Disabled copy already exists.");
    const temporary = `${stash}.${crypto.randomUUID()}.tmp`;
    try {
      await cp(source, temporary, { recursive: true, errorOnExist: true, force: false });
      await rename(temporary, stash);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
    for (const target of targets) if (await fileExists(target)) await rm(target, { recursive: true });
  }
  return { ...skill, enabled };
}

async function inspectOwnedTree(root: string, directory: string): Promise<string> {
  await verifySafeDirectory(root, directory);
  const hash = createHash("sha256");
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = join(directory, entry.name);
    await rejectSymlink(path);
    hash.update(entry.name);
    if (entry.isDirectory()) hash.update(await inspectOwnedTree(root, path));
    else if (entry.isFile()) hash.update(await readFile(path));
    else throw new Error("Unsupported built-in skill file.");
  }
  return hash.digest("hex");
}

function managedSkillName(slug: string, fallback: string): string {
  const names: Record<string, string> = {
    "dani-dex-data": "Shared records",
    "dani-dex-skill-creator": "Reusable workflow creator",
    "dani-dex-site-hosting": "Public site hosting",
  };
  return names[slug] ?? fallback;
}

/** Resume an interrupted disable or restore before a provider starts. Never remove divergent copies. */
async function reconcileDisabledSkill(root: string, slug: string): Promise<void> {
  const stash = join(root, ".dani-dex-disabled-skills", slug);
  const marker = `${JSON.stringify({ managedBy: "danidex", slug, version: 1 })}\n`;
  await verifySafeDirectory(root, stash);
  await rejectSymlink(join(stash, OWNERSHIP_MARKER));
  if ((await optionalText(join(stash, OWNERSHIP_MARKER))) !== marker) throw new Error("Disabled skill is unowned.");
  const hash = await inspectOwnedTree(root, stash);
  const targets = [join(root, ".agents", "skills", slug), join(root, ".claude", "skills", slug)];
  for (const path of targets)
    if (await fileExists(path)) {
      if ((await inspectOwnedTree(root, path)) !== hash)
        throw new Error("Interrupted skill change has different copies. Reconcile before starting.");
    }
  const { rm } = await import("node:fs/promises");
  for (const path of targets) if (await fileExists(path)) await rm(path, { recursive: true });
}
