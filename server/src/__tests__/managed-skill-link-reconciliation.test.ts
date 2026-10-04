import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("current target is a no-op when old and current sources exist under distinct install roots", async () => {
    // Regression coverage for the bounded correction: the prior
    // path-shape heuristic misclassified any link under
    // /installs/<hash>/.../skills/... as drift, including a live link that
    // already points at the *current* install. This test guards against
    // that regression by setting up both old and current sources under
    // distinct cli/installs/<hash>/ roots and pointing the live link at
    // the current source — reconciliation must report zero drift, the
    // link must remain untouched, and the sync must not be invoked.
    const home = await fs.mkdtemp(
      path.join(os.tmpdir(), "paperclip-msr-home-current-noop-"),
    );
    cleanupDirs.push(home);
    const skillsHome = path.join(home, ".pi", "agent", "skills");
    await fs.mkdir(skillsHome, { recursive: true });
    const oldInstallRoot = path.join(root, "cli", "installs", "oldhash-noop");
    const currentInstallRoot = path.join(root, "cli", "installs", "currenthash-noop");
    const oldSource = await makeSkillSource(oldInstallRoot, "paperclip");
    const currentSource = await makeSkillSource(currentInstallRoot, "paperclip");
    // Live link already points at the current source — NOT stale.
    await fs.symlink(currentSource, path.join(skillsHome, "paperclip"));

    const rows: AgentRow[] = [
      {
        id: "agent-current",
        companyId: "company-1",
        adapterType: "pi_local",
        adapterConfig: {
          env: { HOME: home },
          paperclipRuntimeSkills: runtimeEntries([
            {
              key: "paperclipai/paperclip/paperclip",
              runtimeName: "paperclip",
              source: currentSource,
            },
          ]),
        },
      },
    ];
    const beforeLink = await fs.readlink(path.join(skillsHome, "paperclip"));
    const summary = await reconcileManagedSkillLinksOnStartup(makeDb(rows));
    const afterLink = await fs.readlink(path.join(skillsHome, "paperclip"));

    expect(summary.scannedAgents).toBe(1);
    expect(summary.driftedAgents).toBe(0);
    expect(summary.resyncedAgents).toBe(0);
    expect(summary.resyncedAgentIds).toEqual([]);
    expect(summary.failedAgents).toBe(0);
    // Link target is byte-identical before and after reconciliation.
    expect(afterLink).toBe(beforeLink);
    expect(afterLink).toBe(currentSource);
    // Sanity: the two sources really are distinct (the no-op classification
    // isn't vacuous because the inputs collapsed).
    expect(currentSource).not.toBe(oldSource);
  });

  it("detection explicitly classifies 'no-op' vs 'stale' under distinct install roots", async () => {
    // Drives `__testing.detectPiSkillsHomeDrift` directly to lock in the
    // classifier behavior the bounded correction depends on: a link at the
    // current source is NOT drift, while a link at a distinct old source
    // IS drift. Both must use distinct cli/installs/<hash>/ roots so the
    // test exercises the production-shaped scenario, not a contrived
    // single-source fixture.
    const home = await fs.mkdtemp(
      path.join(os.tmpdir(), "paperclip-msr-home-classifier-"),
    );
    cleanupDirs.push(home);
    const skillsHome = path.join(home, ".pi", "agent", "skills");
    await fs.mkdir(skillsHome, { recursive: true });
    const oldInstallRoot = path.join(root, "cli", "installs", "oldhash-classifier");
    const currentInstallRoot = path.join(root, "cli", "installs", "currenthash-classifier");
    const oldSource = await makeSkillSource(oldInstallRoot, "paperclip");
    const currentSource = await makeSkillSource(currentInstallRoot, "paperclip");
    // Live link at the current source: detector must say no-op.
    await fs.symlink(currentSource, path.join(skillsHome, "paperclip"));
    const configCurrent = {
      env: { HOME: home },
      paperclipRuntimeSkills: [
        {
          key: "paperclipai/paperclip/paperclip",
          runtimeName: "paperclip",
          source: currentSource,
        },
      ],
    };
    const noop = await __testing.detectPiSkillsHomeDrift(configCurrent);
    expect(noop.drifted).toBe(false);
    expect(noop.driftedNames).toEqual([]);
    expect(noop.skillsHome).toBe(skillsHome);

    // Now flip the live link to point at the old source: detector must
    // say drift, naming exactly that leaf.
    await fs.unlink(path.join(skillsHome, "paperclip"));
    await fs.symlink(oldSource, path.join(skillsHome, "paperclip"));
    const stale = await __testing.detectPiSkillsHomeDrift(configCurrent);
    expect(stale.drifted).toBe(true);
    expect(stale.driftedNames).toEqual(["paperclip"]);
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

  it("preserves a sibling agent's desired skill across the union without repeatedly syncing an already-repaired sibling (multi-agent shared home)", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-msr-home-union-"));
    cleanupDirs.push(home);
    const skillsHome = path.join(home, ".pi", "agent", "skills");
    await fs.mkdir(skillsHome, { recursive: true });
    // Two skills available; only one (alpha) starts stale, the other (beta)
    // is already current. This agent wants alpha; the sibling wants beta.
    // Drift exists for alpha on first detection — sync must re-point it
    // and union-ensure beta without dropping beta. After this agent's sync
    // fixes alpha, the sibling's detector must see zero drift and skip its
    // sync entirely (no redundant re-pass). Both sources for each skill
    // use the same leaf name so PR #18's stale classifier matches.
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
    // Only the first agent (whichever iteration order reaches the home
    // first) detects drift, because the second agent's detector sees the
    // already-repaired alpha and the already-current beta — both classify
    // as not-stale via `isStalePaperclipManagedSkillLink`. This is the
    // "without repeatedly syncing an already-repaired sibling" invariant.
    expect(summary.driftedAgents).toBe(1);
    expect(summary.resyncedAgents).toBe(1);
    expect(summary.resyncedAgentIds).toHaveLength(1);
    // Alpha re-pointed to the current install root by whichever agent ran first.
    expect(
      path.resolve(skillsHome, await fs.readlink(path.join(skillsHome, "alpha"))),
    ).toBe(currentAlpha);
    // Beta is preserved (union-aware sync composed with PR #18 must not
    // prune it just because this agent doesn't desire beta directly).
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
    // Agent A: a stale link exists in its skills home, but its config has
    // no `paperclipRuntimeSkills` and no moduleDir-resolvable bundled
    // skills. The detector has no current source to compare against, so it
    // cannot prove staleness (the heuristic-free pre-check requires a
    // matching available entry to classify drift). Agent A is a true no-op:
    // no drift detected, no sync attempted, no failure recorded. Its stale
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
    // Agent B succeeds; agent A's no-op (no source to compare against)
    // does not block the sweep. With the pre-check based on
    // `isStalePaperclipManagedSkillLink`, A classifies as not-drift, so it
    // never enters the sync path and is absent from resyncedAgentIds.
    expect(summary.resyncedAgentIds).toContain("agent-b");
    expect(summary.failedAgents).toBe(0);
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

  // JES-421 regression coverage: env.HOME is persisted as a binding object
  // (canonical shape written by `normalizeEnvConfig` on every create/update),
  // not a plain string. Pre-merge QA on the prior PR #23 head found the
  // startup reconciliation silently no-op'd for API-created agents because
  // `resolvePiSkillsHome` required a plain string. These tests pin the fix.
  describe("env.HOME as persisted binding object (JES-421)", () => {
    it("resolves a plain binding's value to the agent's actual skills home", () => {
      // The canonical shape `normalizeEnvConfig` writes on every create/update:
      // `env.HOME = { type: "plain", value: "<path>" }`. Pre-fix, the typeof
      // check rejected this and the function fell back to os.homedir().
      const home = "/tmp/paperclip-msr-jes421-home";
      const config = {
        env: { HOME: { type: "plain", value: home } },
      };
      expect(__testing.resolvePiSkillsHome(config)).toBe(
        path.join(home, ".pi", "agent", "skills"),
      );
    });

    it("falls back to os.homedir() for secret_ref bindings and logs at warn", async () => {
      // Startup-time posture: no secrets service available, so non-plain
      // bindings can't be resolved here. Documented fail-closed behavior —
      // log at warn, fall back to server process home. Matches the
      // platform's overall startup-time access path.
      const { logger } = await import("../middleware/logger.js");
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
      const config = {
        env: {
          HOME: {
            type: "secret_ref",
            secretId: "00000000-0000-0000-0000-000000000001",
            version: "latest",
          },
        },
      };
      expect(__testing.resolvePiSkillsHome(config)).toBe(
        path.join(os.homedir(), ".pi", "agent", "skills"),
      );
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ envKey: "HOME", bindingType: "secret_ref" }),
        expect.stringContaining("cannot resolve secret_ref"),
      );
      warnSpy.mockRestore();
    });

    it("re-points a stale link when env.HOME is the persisted plain binding shape", async () => {
      // The full end-to-end regression: this is the QA repro from
      // [JES-421](/JES/issues/JES-421) acceptance criterion 2, with the
      // row constructed in the persisted shape (env bindings as objects).
      // Pre-fix: scan-and-reconcile returned `{driftedAgents: 0}` because
      // HOME resolution fell back to the process home. Post-fix: drift is
      // detected in the agent's actual home and the link is re-pointed.
      const home = await fs.mkdtemp(
        path.join(os.tmpdir(), "paperclip-msr-jes421-stale-"),
      );
      cleanupDirs.push(home);
      const skillsHome = path.join(home, ".pi", "agent", "skills");
      await fs.mkdir(skillsHome, { recursive: true });
      const oldInstallRoot = path.join(root, "cli", "installs", "oldhash-jes421");
      const currentInstallRoot = path.join(root, "cli", "installs", "currenthash-jes421");
      const oldSource = await makeSkillSource(oldInstallRoot, "paperclip");
      const currentSource = await makeSkillSource(currentInstallRoot, "paperclip");
      await fs.symlink(oldSource, path.join(skillsHome, "paperclip"));

      const rows: AgentRow[] = [
        {
          id: "agent-jes421",
          companyId: "company-1",
          adapterType: "pi_local",
          // Persisted shape: env.HOME is a binding object, not a plain string.
          adapterConfig: {
            env: { HOME: { type: "plain", value: home } },
            paperclipRuntimeSkills: runtimeEntries([
              {
                key: "paperclipai/paperclip/paperclip",
                runtimeName: "paperclip",
                source: currentSource,
              },
            ]),
          },
        },
      ];
      const summary = await reconcileManagedSkillLinksOnStartup(makeDb(rows));
      expect(summary.scannedAgents).toBe(1);
      expect(summary.driftedAgents).toBe(1);
      expect(summary.resyncedAgents).toBe(1);
      expect(summary.resyncedAgentIds).toEqual(["agent-jes421"]);
      expect(summary.failedAgents).toBe(0);
      // Link re-pointed to the current source in the agent's actual home.
      expect(
        path.resolve(skillsHome, await fs.readlink(path.join(skillsHome, "paperclip"))),
      ).toBe(currentSource);
    });

    it("groups siblings by home correctly when env.HOME is the persisted plain binding shape", async () => {
      // The `desiredByHome` per-home union grouping also depends on
      // `resolvePiSkillsHome`. Pre-fix, the binding HOME caused the
      // grouping to be empty (all agents grouped under process home), so
      // union protection for sibling desired skills did not fire. This
      // test pins the union under persisted-binding input.
      const home = await fs.mkdtemp(
        path.join(os.tmpdir(), "paperclip-msr-jes421-union-"),
      );
      cleanupDirs.push(home);
      const skillsHome = path.join(home, ".pi", "agent", "skills");
      await fs.mkdir(skillsHome, { recursive: true });
      const oldInstallRoot = path.join(root, "cli", "installs", "oldhash-jes421-union");
      const currentInstallRoot = path.join(root, "cli", "installs", "currenthash-jes421-union");
      const oldAlpha = await makeSkillSource(oldInstallRoot, "alpha");
      const currentAlpha = await makeSkillSource(currentInstallRoot, "alpha");
      const currentBeta = await makeSkillSource(currentInstallRoot, "beta");
      await fs.symlink(oldAlpha, path.join(skillsHome, "alpha"));
      await fs.symlink(currentBeta, path.join(skillsHome, "beta"));

      const rows: AgentRow[] = [
        {
          id: "agent-alpha",
          companyId: "company-1",
          adapterType: "pi_local",
          adapterConfig: {
            env: { HOME: { type: "plain", value: home } },
            paperclipSkillSync: { desiredSkills: ["paperclipai/paperclip/alpha"] },
            paperclipRuntimeSkills: runtimeEntries([
              { key: "paperclipai/paperclip/alpha", runtimeName: "alpha", source: currentAlpha },
              { key: "paperclipai/paperclip/beta", runtimeName: "beta", source: currentBeta },
            ]),
          },
        },
        {
          id: "agent-beta",
          companyId: "company-1",
          adapterType: "pi_local",
          adapterConfig: {
            env: { HOME: { type: "plain", value: home } },
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
      // First agent detects drift and re-points alpha; second sees no drift
      // (alpha now current) and skips — union preserved.
      expect(summary.driftedAgents).toBe(1);
      expect(summary.resyncedAgents).toBe(1);
      expect(
        path.resolve(skillsHome, await fs.readlink(path.join(skillsHome, "alpha"))),
      ).toBe(currentAlpha);
      // Beta is preserved verbatim — sibling's desired skill survives.
      expect(await fs.readlink(path.join(skillsHome, "beta"))).toBe(currentBeta);
    });
  });

  it("readEnvBindingAsPlainString classifies bindings correctly", () => {
    // Plain string → trimmed value.
    expect(__testing.readEnvBindingAsPlainString("/tmp/x", "HOME")).toBe("/tmp/x");
    expect(__testing.readEnvBindingAsPlainString("  /tmp/x  ", "HOME")).toBe("/tmp/x");
    // Plain binding object → trimmed .value.
    expect(
      __testing.readEnvBindingAsPlainString(
        { type: "plain", value: "/tmp/y" },
        "HOME",
      ),
    ).toBe("/tmp/y");
    expect(
      __testing.readEnvBindingAsPlainString(
        { type: "plain", value: "  /tmp/y  " },
        "HOME",
      ),
    ).toBe("/tmp/y");
    // Non-plain bindings → null (caller logs and falls back).
    expect(
      __testing.readEnvBindingAsPlainString(
        { type: "secret_ref", secretId: "abc" },
        "HOME",
      ),
    ).toBeNull();
    expect(
      __testing.readEnvBindingAsPlainString(
        { type: "user_secret_ref", key: "X" },
        "HOME",
      ),
    ).toBeNull();
    // Empty / whitespace inputs → null.
    expect(__testing.readEnvBindingAsPlainString("", "HOME")).toBeNull();
    expect(__testing.readEnvBindingAsPlainString("   ", "HOME")).toBeNull();
    expect(
      __testing.readEnvBindingAsPlainString({ type: "plain", value: "   " }, "HOME"),
    ).toBeNull();
    // Malformed inputs → null (defensive).
    expect(__testing.readEnvBindingAsPlainString(null, "HOME")).toBeNull();
    expect(__testing.readEnvBindingAsPlainString(undefined, "HOME")).toBeNull();
    expect(__testing.readEnvBindingAsPlainString(42, "HOME")).toBeNull();
    expect(
      __testing.readEnvBindingAsPlainString({ type: "plain" }, "HOME"),
    ).toBeNull();
    expect(
      __testing.readEnvBindingAsPlainString({ type: "plain", value: 42 }, "HOME"),
    ).toBeNull();
    expect(
      __testing.readEnvBindingAsPlainString(["a", "b"], "HOME"),
    ).toBeNull();
  });
});