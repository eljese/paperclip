import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listPiSkills,
  syncPiSkills,
} from "@paperclipai/adapter-pi-local/server";

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function makeSkillSource(root: string, name: string): Promise<string> {
  const source = path.join(root, "skills", name);
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, "SKILL.md"), `# ${name}\n`, "utf8");
  return source;
}

function piCtx(home: string, entries: Array<{ key: string; runtimeName: string; source: string }>) {
  return {
    agentId: "agent-1",
    companyId: "company-1",
    adapterType: "pi_local",
    config: {
      env: { HOME: home },
      paperclipRuntimeSkills: entries,
    },
  } as const;
}

function skillsHome(home: string): string {
  return path.join(home, ".pi", "agent", "skills");
}

describe("pi local skill sync", () => {
  const paperclipKey = "paperclipai/paperclip/paperclip";
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    cleanupDirs.clear();
  });

  it("defaults and installs the operational Paperclip skill in the Pi skills home", async () => {
    const home = await makeTempDir("paperclip-pi-skill-sync-");
    cleanupDirs.add(home);

    const ctx = {
      agentId: "agent-1",
      companyId: "company-1",
      adapterType: "pi_local",
      config: {
        env: {
          HOME: home,
        },
      },
    } as const;

    const before = await listPiSkills(ctx);
    expect(before.mode).toBe("persistent");
    expect(before.desiredSkills).toContain(paperclipKey);
    expect(before.entries.find((entry) => entry.key === paperclipKey)?.state).toBe("missing");

    const after = await syncPiSkills(ctx, [paperclipKey]);
    expect(after.entries.find((entry) => entry.key === paperclipKey)?.state).toBe("installed");
    expect((await fs.lstat(path.join(home, ".pi", "agent", "skills", "paperclip"))).isSymbolicLink()).toBe(true);
  });

  it("keeps a sibling agent's skill: union-aware sync never prunes keys desired by somebody", async () => {
    const home = await makeTempDir("paperclip-pi-union-keep-");
    const newRoot = await makeTempDir("paperclip-pi-union-src-");
    cleanupDirs.add(home);
    cleanupDirs.add(newRoot);
    const alphaKey = "paperclipai/paperclip/alpha";
    const betaKey = "paperclipai/paperclip/beta";
    const alphaSource = await makeSkillSource(newRoot, "alpha");
    const betaSource = await makeSkillSource(newRoot, "beta");
    await fs.mkdir(skillsHome(home), { recursive: true });
    // Sibling agent's skill is already linked; this agent only wants alpha.
    await fs.symlink(betaSource, path.join(skillsHome(home), "beta"));

    await syncPiSkills(
      piCtx(home, [
        { key: alphaKey, runtimeName: "alpha", source: alphaSource },
        { key: betaKey, runtimeName: "beta", source: betaSource },
      ]),
      [alphaKey],
      { unionDesiredSkills: [alphaKey, betaKey] },
    );

    expect(await fs.readlink(path.join(skillsHome(home), "alpha"))).toBe(alphaSource);
    // Beta survives even though this agent does not desire it.
    expect(await fs.readlink(path.join(skillsHome(home), "beta"))).toBe(betaSource);
  });

  it("re-points a live stale link from a retained old install root at the current source", async () => {
    const home = await makeTempDir("paperclip-pi-stale-");
    const oldRoot = await makeTempDir("paperclip-pi-stale-old-");
    const newRoot = await makeTempDir("paperclip-pi-stale-new-");
    cleanupDirs.add(home);
    cleanupDirs.add(oldRoot);
    cleanupDirs.add(newRoot);
    const alphaKey = "paperclipai/paperclip/alpha";
    const oldSource = await makeSkillSource(oldRoot, "alpha");
    const newSource = await makeSkillSource(newRoot, "alpha");
    await fs.mkdir(skillsHome(home), { recursive: true });
    // Simulated pre-upgrade link: live (old install dir retained), wrong root.
    await fs.symlink(oldSource, path.join(skillsHome(home), "alpha"));

    await syncPiSkills(
      piCtx(home, [{ key: alphaKey, runtimeName: "alpha", source: newSource }]),
      [alphaKey],
    );

    expect(path.resolve(skillsHome(home), await fs.readlink(path.join(skillsHome(home), "alpha")))).toBe(newSource);
    expect(oldSource).not.toBe(newSource);
  });

  it("still prunes a managed link desired by nobody in the union", async () => {
    const home = await makeTempDir("paperclip-pi-prune-");
    const newRoot = await makeTempDir("paperclip-pi-prune-src-");
    cleanupDirs.add(home);
    cleanupDirs.add(newRoot);
    const alphaKey = "paperclipai/paperclip/alpha";
    const betaKey = "paperclipai/paperclip/beta";
    const alphaSource = await makeSkillSource(newRoot, "alpha");
    const betaSource = await makeSkillSource(newRoot, "beta");
    await fs.mkdir(skillsHome(home), { recursive: true });
    await fs.symlink(alphaSource, path.join(skillsHome(home), "alpha"));
    await fs.symlink(betaSource, path.join(skillsHome(home), "beta"));

    // Union shrank: nobody wants beta any more.
    await syncPiSkills(
      piCtx(home, [
        { key: alphaKey, runtimeName: "alpha", source: alphaSource },
        { key: betaKey, runtimeName: "beta", source: betaSource },
      ]),
      [alphaKey],
      { unionDesiredSkills: [alphaKey] },
    );

    expect(await fs.readlink(path.join(skillsHome(home), "alpha"))).toBe(alphaSource);
    await expect(fs.lstat(path.join(skillsHome(home), "beta"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never touches user-installed or external entries", async () => {
    const home = await makeTempDir("paperclip-pi-external-");
    const newRoot = await makeTempDir("paperclip-pi-external-src-");
    const userRoot = await makeTempDir("paperclip-pi-external-user-");
    cleanupDirs.add(home);
    cleanupDirs.add(newRoot);
    cleanupDirs.add(userRoot);
    const alphaKey = "paperclipai/paperclip/alpha";
    const alphaSource = await makeSkillSource(newRoot, "alpha");
    await fs.mkdir(skillsHome(home), { recursive: true });
    // User-installed: real directory, retained backup dir, foreign symlink.
    await fs.mkdir(path.join(skillsHome(home), "demo-skill"));
    await fs.writeFile(path.join(skillsHome(home), "demo-skill", "SKILL.md"), "# demo\n", "utf8");
    await fs.mkdir(path.join(skillsHome(home), ".bak-alpha"));
    const userTarget = path.join(userRoot, "my-custom-skill");
    await fs.mkdir(userTarget, { recursive: true });
    await fs.symlink(userTarget, path.join(skillsHome(home), "custom"));

    await syncPiSkills(
      piCtx(home, [{ key: alphaKey, runtimeName: "alpha", source: alphaSource }]),
      [alphaKey],
      { unionDesiredSkills: [alphaKey] },
    );

    expect(await fs.readlink(path.join(skillsHome(home), "alpha"))).toBe(alphaSource);
    expect((await fs.stat(path.join(skillsHome(home), "demo-skill"))).isDirectory()).toBe(true);
    expect((await fs.stat(path.join(skillsHome(home), ".bak-alpha"))).isDirectory()).toBe(true);
    expect(await fs.readlink(path.join(skillsHome(home), "custom"))).toBe(userTarget);
  });
});
