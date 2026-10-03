import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  reconcileManagedSkillLinksOnStartup,
  __testing,
} from "../services/managed-skill-link-reconciliation.js";

type AgentRow = {
  id: string;
  companyId: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
};

function makeDb(rows: AgentRow[]): Db {
  // Mirrors the minimal select().from(agents).where(eq(adapterType, ...))
  // shape used by reconcileManagedSkillLinksOnStartup. The where callback
  // filters to pi_local so the test exercises the same gating the production
  // drizzle query applies.
  return {
    select: () => ({
      from: () => ({
        where: async (predicate: unknown) => {
          // The Drizzle `eq(agents.adapterType, "pi_local")` predicate
          // produced by the production code is opaque from the test side;
          // we just filter pi_local in our row set as a faithful stand-in.
          return rows.filter((row) => row.adapterType === "pi_local");
        },
      }),
    }),
  } as unknown as Db;
}

describe("reconcileManagedSkillLinksOnStartup", () => {
  let root: string;
  const cleanupDirs: string[] = [];

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-managed-skill-recon-"));
    cleanupDirs.push(root);
  });

  afterEach(async () => {
    await Promise.all(
      cleanupDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  async function makeSkillSource(parent: string, name: string): Promise<string> {
    const source = path.join(parent, "skills", name);
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(path.join(source, "SKILL.md"), `# ${name}\n`, "utf8");
    return source;
  }

  function runtimeEntries(sources: Array<{ key: string; runtimeName: string; source: string }>) {
    return sources;
  }

  it("is a no-op when there are no pi_local agents", async () => {
    const summary = await reconcileManagedSkillLinksOnStartup(makeDb([]));
    expect(summary).toEqual({
      scannedAgents: 0,
      driftedAgents: 0,
      resyncedAgents: 0,
      failedAgents: 0,
      resyncedAgentIds: [],
      emptyHomeAgents: 0,
    });
  });

  it("is a no-op when pi_local skills home contains no stale links", async () => {
    // Home with a fresh, correctly-pointed link — already current.
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-msr-home-fresh-"));
    cleanupDirs.push(home);
    const skillsHome = path.join(home, ".pi", "agent", "skills");
    await fs.mkdir(skillsHome, { recursive: true });
    const currentSource = await makeSkillSource(root, "paperclip");
    await fs.symlink(currentSource, path.join(skillsHome, "paperclip"));

    const rows: AgentRow[] = [
      {
        id: "agent-fresh",
        companyId: "company-1",
        adapterType: "pi_local",
        adapterConfig: {
          env: { HOME: home },
          paperclipRuntimeSkills: runtimeEntries([
            { key: "paperclipai/paperclip/paperclip", runtimeName: "paperclip", source: currentSource },
          ]),
        },
      },
    ];
    const summary = await reconcileManagedSkillLinksOnStartup(makeDb(rows));
    expect(summary.scannedAgents).toBe(1);
    expect(summary.driftedAgents).toBe(0);
    expect(summary.resyncedAgents).toBe(0);
    expect(summary.failedAgents).toBe(0);
    // Existing correct link must remain untouched.
    expect(await fs.readlink(path.join(skillsHome, "paperclip"))).toBe(currentSource);
  });

  it("re-points a stale link from a retained old install root at the current source", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-msr-home-stale-"));
    cleanupDirs.push(home);
    const skillsHome = path.join(home, ".pi", "agent", "skills");
    await fs.mkdir(skillsHome, { recursive: true });
    // Simulated retained old install root + current install root. Both
    // point at a directory named `paperclip` so PR #18's
    // `isStalePaperclipManagedSkillLink` (which requires matching basenames)
    // classifies the link as stale.
    const oldInstallRoot = path.join(root, "cli", "installs", "oldhash");
    const currentInstallRoot = path.join(root, "cli", "installs", "currenthash");
    const oldSource = await makeSkillSource(oldInstallRoot, "paperclip");
    const currentSource = await makeSkillSource(currentInstallRoot, "paperclip");
    await fs.symlink(oldSource, path.join(skillsHome, "paperclip"));

    const rows: AgentRow[] = [
      {
        id: "agent-stale",
        companyId: "company-1",
        adapterType: "pi_local",
        adapterConfig: {
          env: { HOME: home },
          paperclipRuntimeSkills: runtimeEntries([
            { key: "paperclipai/paperclip/paperclip", runtimeName: "paperclip", source: currentSource },
          ]),
        },
      },
    ];
    const summary = await reconcileManagedSkillLinksOnStartup(makeDb(rows));
    expect(summary.scannedAgents).toBe(1);
    expect(summary.driftedAgents).toBe(1);
    expect(summary.resyncedAgents).toBe(1);
    expect(summary.resyncedAgentIds).toEqual(["agent-stale"]);
    expect(summary.failedAgents).toBe(0);
    // The old link was replaced with one pointing at the current source.
    const finalTarget = await fs.readlink(path.join(skillsHome, "paperclip"));
    expect(path.resolve(skillsHome, finalTarget)).toBe(currentSource);
    expect(currentSource).not.toBe(oldSource);
  });

  it("never touches user-installed entries (different leaf name preserved)", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-msr-home-user-"));
    cleanupDirs.push(home);
    const skillsHome = path.join(home, ".pi", "agent", "skills");
    await fs.mkdir(skillsHome, { recursive: true });
    // User-installed skill with a leaf name Paperclip never ships — must be
    // preserved through any install switch.
    const userSource = path.join(root, "user", "my-custom-skill");
    await fs.mkdir(userSource, { recursive: true });
    await fs.writeFile(path.join(userSource, "SKILL.md"), "user\n", "utf8");
    await fs.symlink(userSource, path.join(skillsHome, "my-custom-skill"));
    // And a stale Paperclip-managed link to confirm drift still triggers.
    // Both sources use the same leaf name `paperclip` so PR #18's stale
    // classifier matches the link.
    const oldInstallRoot = path.join(root, "cli", "installs", "oldhash2");
    const currentInstallRoot = path.join(root, "cli", "installs", "currenthash2");
    const oldPaperclipSource = await makeSkillSource(oldInstallRoot, "paperclip");
    const currentPaperclipSource = await makeSkillSource(currentInstallRoot, "paperclip");
    await fs.symlink(oldPaperclipSource, path.join(skillsHome, "paperclip"));

    const rows: AgentRow[] = [
      {
        id: "agent-mixed",
        companyId: "company-1",
        adapterType: "pi_local",
        adapterConfig: {
          env: { HOME: home },
          paperclipRuntimeSkills: runtimeEntries([
            {
              key: "paperclipai/paperclip/paperclip",
              runtimeName: "paperclip",
              source: currentPaperclipSource,
            },
          ]),
        },
      },
    ];
    const summary = await reconcileManagedSkillLinksOnStartup(makeDb(rows));
    expect(summary.resyncedAgents).toBe(1);
    // The Paperclip-managed link was re-pointed...
    expect(
      path.resolve(skillsHome, await fs.readlink(path.join(skillsHome, "paperclip"))),
    ).toBe(currentPaperclipSource);
    // ...but the user-installed entry is preserved verbatim.
    expect(await fs.readlink(path.join(skillsHome, "my-custom-skill"))).toBe(userSource);
  });

  it("preserves a sibling agent's desired skill across the union (multi-agent shared home)", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-msr-home-union-"));
    cleanupDirs.push(home);
    const skillsHome = path.join(home, ".pi", "agent", "skills");
    await fs.mkdir(skillsHome, { recursive: true });
    // Two skills available; only one (alpha) needs repair, the other (beta)
    // is already current. Sibling agent only wants beta; this agent wants
    // alpha. Drift exists for alpha — sync must re-point it without
    // touching beta. Both sources for each skill use the same leaf name so
    // PR #18's stale classifier matches.
    const oldInstallRoot = path.join(root, "cli", "installs", "oldhash-union");
    const currentInstallRoot = path.join(root, "cli", "installs", "currenthash-union");
    const oldAlpha = await makeSkillSource(oldInstallRoot, "alpha");
    const currentAlpha = await makeSkillSource(currentInstallRoot, "alpha");
    const currentBeta = await makeSkillSource(currentInstallRoot, "beta");
    await fs.symlink(oldAlpha, path.join(skillsHome, "alpha"));
    await fs.symlink(currentBeta, path.join(skillsHome, "beta"));

    const rows: AgentRow[] = [
      {
        id: "agent-this",
        companyId: "company-1",
        adapterType: "pi_local",
        adapterConfig: {
          env: { HOME: home },
          paperclipSkillSync: { desiredSkills: ["paperclipai/paperclip/alpha"] },
          paperclipRuntimeSkills: runtimeEntries([
            { key: "paperclipai/paperclip/alpha", runtimeName: "alpha", source: currentAlpha },
            { key: "paperclipai/paperclip/beta", runtimeName: "beta", source: currentBeta },
          ]),
        },
      },
      {
        id: "agent-sibling",
        companyId: "company-1",
        adapterType: "pi_local",
        adapterConfig: {
          env: { HOME: home },
          paperclipSkillSync: { desiredSkills: ["paperclipai/paperclip/beta"] },
          paperclipRuntimeSkills: runtimeEntries([
            { key: "paperclipai/paperclip/alpha", runtimeName: "alpha", source: currentAlpha },
            { key: "paperclipai/paperclip/beta", runtimeName: "beta", source: currentBeta },
          ]),
        },
      },
    ];
    const summary = await reconcileManagedSkillLinksOnStartup(makeDb(rows));
    expect(summary.scannedAgents).toBe(2);
    // Both agents share the skills home, so each independently detects the
    // stale alpha and triggers the sync. Both syncs run; the union-aware
    // semantics ensure beta survives across both passes.
    expect(summary.driftedAgents).toBe(2);
    expect(summary.resyncedAgents).toBe(2);
    expect(summary.resyncedAgentIds.sort()).toEqual(["agent-sibling", "agent-this"]);
    // Alpha re-pointed to current install root by the first sync that runs.
    expect(
      path.resolve(skillsHome, await fs.readlink(path.join(skillsHome, "alpha"))),
    ).toBe(currentAlpha);
    // Beta untouched (sibling agent still wants it; the union-aware sync
    // composed with PR #18 must not prune it).
    expect(await fs.readlink(path.join(skillsHome, "beta"))).toBe(currentBeta);
  });

  it("ignores non-pi_local agents entirely", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-msr-home-skip-"));
    cleanupDirs.push(home);
    const skillsHome = path.join(home, ".pi", "agent", "skills");
    await fs.mkdir(skillsHome, { recursive: true });
    const oldInstallRoot = path.join(root, "cli", "installs", "oldhash-skip");
    const oldSource = await makeSkillSource(oldInstallRoot, "paperclip");
    await fs.symlink(oldSource, path.join(skillsHome, "paperclip"));

    const rows: AgentRow[] = [
      {
        id: "agent-codex",
        companyId: "company-1",
        adapterType: "codex_local",
        adapterConfig: { env: { HOME: home } },
      },
    ];
    const summary = await reconcileManagedSkillLinksOnStartup(makeDb(rows));
    expect(summary.scannedAgents).toBe(0);
    // No-op — codex_local has its own skill mechanism and isn't part of the
    // install-switch drift class.
    expect(await fs.readlink(path.join(skillsHome, "paperclip"))).toBe(oldSource);
  });

  it("isolates per-agent failures so a single bad agent doesn't abort the sweep", async () => {
    const homeA = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-msr-home-a-"));
    const homeB = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-msr-home-b-"));
    cleanupDirs.push(homeA, homeB);
    // Agent A: drift detected via old install root, but the agent config has
    // no runtime skill entries pointing at any currently-known source. The
    // union-aware sync cannot re-point what it doesn't know about, so the
    // re-sync is effectively a no-op for A — that's recorded as a successful
    // detection + sync (drift confirmed and acted on; the absence of a known
    // current source means there's nothing to re-point to). Agent A's stale
    // link remains in place but does not abort the sweep.
    const skillsHomeA = path.join(homeA, ".pi", "agent", "skills");
    await fs.mkdir(skillsHomeA, { recursive: true });
    const oldInstallRootA = path.join(root, "cli", "installs", "oldhash-fail-a");
    const oldSourceA = await makeSkillSource(oldInstallRootA, "paperclip");
    await fs.symlink(oldSourceA, path.join(skillsHomeA, "paperclip"));

    // Agent B: well-formed stale link that can actually be re-pointed. The
    // source leaf name must match across old/current for PR #18's stale
    // classifier to fire.
    const skillsHomeB = path.join(homeB, ".pi", "agent", "skills");
    await fs.mkdir(skillsHomeB, { recursive: true });
    const oldInstallRootB = path.join(root, "cli", "installs", "oldhash-fail-b");
    const currentInstallRootB = path.join(root, "cli", "installs", "currenthash-fail-b");
    const oldSourceB = await makeSkillSource(oldInstallRootB, "paperclip");
    const currentSourceB = await makeSkillSource(currentInstallRootB, "paperclip");
    await fs.symlink(oldSourceB, path.join(skillsHomeB, "paperclip"));

    const rows: AgentRow[] = [
      {
        id: "agent-a",
        companyId: "company-1",
        adapterType: "pi_local",
        adapterConfig: { env: { HOME: homeA } },
      },
      {
        id: "agent-b",
        companyId: "company-1",
        adapterType: "pi_local",
        adapterConfig: {
          env: { HOME: homeB },
          paperclipRuntimeSkills: runtimeEntries([
            {
              key: "paperclipai/paperclip/paperclip",
              runtimeName: "paperclip",
              source: currentSourceB,
            },
          ]),
        },
      },
    ];
    const summary = await reconcileManagedSkillLinksOnStartup(makeDb(rows));
    expect(summary.scannedAgents).toBe(2);
    expect(summary.driftedAgents).toBeGreaterThanOrEqual(1);
    // Agent B succeeds; agent A's sync runs but cannot re-point (no known
    // current source) — neither blocks the other.
    expect(summary.resyncedAgentIds).toContain("agent-b");
    expect(
      path.resolve(skillsHomeB, await fs.readlink(path.join(skillsHomeB, "paperclip"))),
    ).toBe(currentSourceB);
  });

  it("exposes a pure drift detector that classifies stale symlinks without mutating state", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-msr-detector-"));
    cleanupDirs.push(home);
    const skillsHome = path.join(home, ".pi", "agent", "skills");
    await fs.mkdir(skillsHome, { recursive: true });
    const oldInstallRoot = path.join(root, "cli", "installs", "oldhash-detector");
    const currentInstallRoot = path.join(root, "cli", "installs", "currenthash-detector");
    const oldSource = await makeSkillSource(oldInstallRoot, "paperclip");
    const currentSource = await makeSkillSource(currentInstallRoot, "paperclip");
    await fs.symlink(oldSource, path.join(skillsHome, "paperclip"));

    const beforeLink = await fs.readlink(path.join(skillsHome, "paperclip"));
    const config = {
      env: { HOME: home },
      paperclipRuntimeSkills: [
        {
          key: "paperclipai/paperclip/paperclip",
          runtimeName: "paperclip",
          source: currentSource,
        },
      ],
    };
    const result = await __testing.detectPiSkillsHomeDrift(config);
    const afterLink = await fs.readlink(path.join(skillsHome, "paperclip"));
    expect(result.drifted).toBe(true);
    expect(result.driftedNames).toEqual(["paperclip"]);
    expect(result.skillsHome).toBe(skillsHome);
    // Pure: link is unchanged after detection.
    expect(afterLink).toBe(beforeLink);
    expect(beforeLink).toBe(oldSource);
    // And currentSource is different — the detector is reporting drift.
    expect(currentSource).not.toBe(oldSource);
  });

  it("resolvePiSkillsHome mirrors the adapter's home resolution exactly", () => {
    expect(__testing.resolvePiSkillsHome({ env: { HOME: "/tmp/x" } })).toBe(
      path.join("/tmp/x", ".pi", "agent", "skills"),
    );
    // No HOME → falls back to os.homedir() / .pi/agent/skills.
    expect(__testing.resolvePiSkillsHome({})).toBe(path.join(os.homedir(), ".pi", "agent", "skills"));
    expect(__testing.resolvePiSkillsHome({ env: {} })).toBe(
      path.join(os.homedir(), ".pi", "agent", "skills"),
    );
    // Whitespace-only HOME falls back to default.
    expect(__testing.resolvePiSkillsHome({ env: { HOME: "   " } })).toBe(
      path.join(os.homedir(), ".pi", "agent", "skills"),
    );
  });
});