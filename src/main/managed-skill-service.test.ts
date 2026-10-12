import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSummary } from "@dani-dex/contracts/ipc";
import { afterEach, describe, expect, it } from "vitest";
import { listManagedSkillsForChat, ManagedSkillService, setManagedSkillEnabled } from "./managed-skill-service";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("managed site hosting skill", () => {
  it("installs the skill creation guide beside the hosting guide", async () => {
    const root = await mkdtemp(join(tmpdir(), "dani-dex-skill-creator-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await expect(listManagedSkillsForChat(agent(workspace))).resolves.toEqual([]);
    const source = join(process.cwd(), "resources/managed-skills/dani-dex-skill-creator/SKILL.md");
    await new ManagedSkillService(source, undefined, undefined, "dani-dex-skill-creator").syncAgent(agent(workspace));
    for (const provider of ["codex", "claude"] as const) {
      await expect(listManagedSkillsForChat({ ...agent(workspace), provider })).resolves.toEqual([
        expect.objectContaining({ skillId: "dani-dex-skill-creator", origin: "managed", enabled: true }),
      ]);
    }
    for (const provider of [".agents", ".claude"]) {
      const content = await readFile(join(workspace, provider, "skills/dani-dex-skill-creator/SKILL.md"), "utf8");
      expect(content).toContain("create_skill");
      expect(content).toContain("expectedRevision");
    }
  });

  it("synchronizes the managed skill for Codex, Grok, and Claude locations", async () => {
    const root = await mkdtemp(join(tmpdir(), "dani-dex-managed-skill-"));
    roots.push(root);
    const source = join(root, "SKILL.md");
    const content = "---\nname: dani-dex-site-hosting\ndescription: Host static sites.\n---\n\nRules\n";
    await writeFile(source, content);
    const workspacePath = join(root, "workspace");
    await mkdir(workspacePath);
    const managedAgent = agent(workspacePath);

    await new ManagedSkillService(source).syncAgent(managedAgent);

    await expect(
      readFile(join(workspacePath, ".agents", "skills", "dani-dex-site-hosting", "SKILL.md"), "utf8"),
    ).resolves.toBe(content);
    await expect(
      readFile(join(workspacePath, ".claude", "skills", "dani-dex-site-hosting", "SKILL.md"), "utf8"),
    ).resolves.toBe(content);

    const updated = content.replace("Rules", "Updated rules");
    await writeFile(source, updated);
    await new ManagedSkillService(source).syncAgent(managedAgent);
    await expect(
      readFile(join(workspacePath, ".agents", "skills", "dani-dex-site-hosting", "SKILL.md"), "utf8"),
    ).resolves.toBe(updated);
  });

  it("preserves and reports an unowned skill collision", async () => {
    const root = await mkdtemp(join(tmpdir(), "dani-dex-managed-skill-"));
    roots.push(root);
    const source = join(root, "SKILL.md");
    const content = "---\nname: dani-dex-site-hosting\ndescription: Host static sites.\n---\n\nRules\n";
    const userContent = "---\nname: dani-dex-site-hosting\ndescription: User skill.\n---\n\nKeep this file.\n";
    await writeFile(source, content);
    const workspacePath = join(root, "workspace");
    const userTarget = join(workspacePath, ".agents", "skills", "dani-dex-site-hosting", "SKILL.md");
    await mkdir(join(workspacePath, ".agents", "skills", "dani-dex-site-hosting"), { recursive: true });
    await writeFile(userTarget, userContent);
    const collisions: string[] = [];

    await new ManagedSkillService(source, (target) => collisions.push(target)).syncAgent(agent(workspacePath));

    await expect(readFile(userTarget, "utf8")).resolves.toBe(userContent);
    await expect(
      readFile(join(workspacePath, ".claude", "skills", "dani-dex-site-hosting", "SKILL.md"), "utf8"),
    ).resolves.toBe(content);
    expect(collisions).toEqual([userTarget]);
  });

  it("continues synchronization when one workspace target is inaccessible", async () => {
    const root = await mkdtemp(join(tmpdir(), "dani-dex-managed-skill-"));
    roots.push(root);
    const source = join(root, "SKILL.md");
    const content = "---\nname: dani-dex-site-hosting\ndescription: Host static sites.\n---\n\nRules\n";
    await writeFile(source, content);
    const blockedWorkspace = join(root, "blocked-workspace");
    const healthyWorkspace = join(root, "healthy-workspace");
    await mkdir(blockedWorkspace, { recursive: true });
    await mkdir(healthyWorkspace, { recursive: true });
    await writeFile(join(blockedWorkspace, ".agents"), "This path is not a directory.");
    const failures: string[] = [];
    const service = new ManagedSkillService(
      source,
      () => undefined,
      (target) => failures.push(target),
    );

    await expect(service.syncAll([agent(blockedWorkspace), agent(healthyWorkspace)])).resolves.toBeUndefined();

    await expect(
      readFile(join(blockedWorkspace, ".claude", "skills", "dani-dex-site-hosting", "SKILL.md"), "utf8"),
    ).resolves.toBe(content);
    await expect(
      readFile(join(healthyWorkspace, ".agents", "skills", "dani-dex-site-hosting", "SKILL.md"), "utf8"),
    ).resolves.toBe(content);
    await expect(
      readFile(join(healthyWorkspace, ".claude", "skills", "dani-dex-site-hosting", "SKILL.md"), "utf8"),
    ).resolves.toBe(content);
    expect(failures).toEqual([join(blockedWorkspace, ".agents", "skills", "dani-dex-site-hosting", "SKILL.md")]);
  });

  it("rejects managed-skill directories that are symlinks outside the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "dani-dex-managed-skill-"));
    roots.push(root);
    const source = join(root, "SKILL.md");
    const content = "---\nname: dani-dex-site-hosting\ndescription: Host static sites.\n---\n\nRules\n";
    await writeFile(source, content);
    const workspacePath = join(root, "workspace");
    const outside = join(root, "outside");
    await mkdir(workspacePath);
    await mkdir(outside);
    await mkdir(join(workspacePath, ".agents", "skills"), { recursive: true });
    await symlink(outside, join(workspacePath, ".agents", "skills", "dani-dex-site-hosting"));
    const failures: string[] = [];

    await new ManagedSkillService(
      source,
      () => undefined,
      (target) => failures.push(target),
    ).syncAgent(agent(workspacePath));

    await expect(readFile(join(outside, "SKILL.md"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      readFile(join(workspacePath, ".claude", "skills", "dani-dex-site-hosting", "SKILL.md"), "utf8"),
    ).resolves.toBe(content);
    expect(failures).toEqual([join(workspacePath, ".agents", "skills", "dani-dex-site-hosting", "SKILL.md")]);
  });
});

function agent(workspacePath: string): AgentSummary {
  return {
    id: "bot-1",
    provider: "codex",
    name: "Builder",
    title: "Site builder",
    description: "Builds static sites.",
    notifications: true,
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
    threadId: "thread-1",
    workspacePath,
    preview: "",
    updatedAt: null,
    avatarSeed: "bot-1",
    avatarHue: null,
    avatarUrl: null,
  };
}

describe("owner controls for built-in skills", () => {
  it("disables both providers, persists across sync, and restores assets", async () => {
    const root = await mkdtemp(join(tmpdir(), "dani-managed-controls-"));
    try {
      const workspace = join(root, "agent");
      await mkdir(workspace);
      const profile = agent(workspace);
      const source = join(process.cwd(), "resources/managed-skills/dani-dex-skill-creator/SKILL.md");
      const sync = new ManagedSkillService(source, undefined, undefined, "dani-dex-skill-creator");
      await sync.syncAgent(profile);
      expect(await setManagedSkillEnabled(profile, "dani-dex-skill-creator", false)).toMatchObject({ enabled: false });
      await sync.syncAgent(profile);
      expect(await listManagedSkillsForChat(profile)).toEqual([expect.objectContaining({ enabled: false })]);
      await expect(readFile(join(workspace, ".agents/skills/dani-dex-skill-creator/SKILL.md"))).rejects.toThrow();
      await expect(readFile(join(workspace, ".claude/skills/dani-dex-skill-creator/SKILL.md"))).rejects.toThrow();
      await setManagedSkillEnabled(profile, "dani-dex-skill-creator", true);
      expect(await listManagedSkillsForChat(profile)).toEqual([expect.objectContaining({ enabled: true })]);
      expect(await readFile(join(workspace, ".claude/skills/dani-dex-skill-creator/SKILL.md"), "utf8")).toContain(
        "Create a local skill",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("preserves different provider copies rather than deleting local edits", async () => {
    const root = await mkdtemp(join(tmpdir(), "dani-managed-conflict-"));
    try {
      const workspace = join(root, "agent");
      await mkdir(workspace);
      const profile = agent(workspace);
      await new ManagedSkillService(
        join(process.cwd(), "resources/managed-skills/dani-dex-site-hosting/SKILL.md"),
      ).syncAgent(profile);
      const path = join(workspace, ".claude/skills/dani-dex-site-hosting/SKILL.md");
      await writeFile(path, (await readFile(path, "utf8")) + "\nlocal edit");
      await expect(setManagedSkillEnabled(profile, "dani-dex-site-hosting", false)).rejects.toThrow("copies differ");
      expect(await readFile(path, "utf8")).toContain("local edit");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

it("reconciles a crash after saving the disabled bundle without losing binary assets", async () => {
  const root = await mkdtemp(join(tmpdir(), "dani-managed-crash-"));
  try {
    const workspace = join(root, "agent");
    await mkdir(workspace);
    const profile = agent(workspace);
    const slug = "dani-dex-skill-creator";
    const sync = new ManagedSkillService(
      join(process.cwd(), `resources/managed-skills/${slug}/SKILL.md`),
      undefined,
      undefined,
      slug,
    );
    await sync.syncAgent(profile);
    const asset = new Uint8Array([0, 255, 130, 64]);
    for (const folder of [".agents", ".claude"])
      await writeFile(join(workspace, folder, "skills", slug, "binary.png"), asset);
    await mkdir(join(workspace, ".dani-dex-disabled-skills"));
    await cp(join(workspace, ".agents", "skills", slug), join(workspace, ".dani-dex-disabled-skills", slug), {
      recursive: true,
    });
    await sync.syncAgent(profile);
    await expect(readFile(join(workspace, ".agents", "skills", slug, "SKILL.md"))).rejects.toThrow();
    await setManagedSkillEnabled(profile, slug, true);
    expect(new Uint8Array(await readFile(join(workspace, ".claude", "skills", slug, "binary.png")))).toEqual(asset);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("honors provider explicit invocation flags in managed metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "dani-managed-metadata-"));
  try {
    const workspace = join(root, "agent");
    await mkdir(workspace);
    const source = join(root, "SKILL.md");
    await writeFile(
      source,
      "---\nname: explicit-only\ndescription: workflow\ndisable-model-invocation: true\n---\nGuide",
    );
    await new ManagedSkillService(source, undefined, undefined, "explicit-only").syncAgent(agent(workspace));
    expect(await listManagedSkillsForChat(agent(workspace))).toEqual([
      expect.objectContaining({ disableModelInvocation: true }),
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
