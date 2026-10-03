import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  readInstalledSkillTargets,
  readPaperclipSkillSyncPreference,
} from "@paperclipai/adapter-utils/server-utils";
import { syncPiSkills } from "@paperclipai/adapter-pi-local/server";
import { logger } from "../middleware/logger.js";

export interface ManagedSkillLinkReconciliationSummary {
  scannedAgents: number;
  driftedAgents: number;
  resyncedAgents: number;
  failedAgents: number;
  resyncedAgentIds: string[];
  emptyHomeAgents: number;
}

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Mirrors `resolvePiSkillsHome` from `@paperclipai/adapter-pi-local/server`
 * exactly. The reconciliation groups agents by skills home so the union of
 * desired skills (passed to `syncPiSkills` as `unionDesiredSkills`) matches
 * the per-home sibling set the explicit POST /agents/:id/skills/sync endpoint
 * computes. Centralizing the helper here keeps both paths in lock-step.
 */
function resolvePiSkillsHome(config: Record<string, unknown>): string {
  const env = asRecord(config.env);
  const configuredHome =
    typeof env.HOME === "string" && env.HOME.trim() ? env.HOME.trim() : null;
  const home = configuredHome ? path.resolve(configuredHome) : os.homedir();
  return path.join(home, ".pi", "agent", "skills");
}

/**
 * Heuristic that catches "silent staleness" without depending on the
 * adapter-utils `readPaperclipRuntimeSkillEntries` resolution path (which
 * looks for bundled skills relative to a moduleDir that varies between dev
 * and build outputs and would either miss in dev or break in installed
 * binaries):
 *
 *   A symlink in the skills home is a drift candidate when its absolute
 *   target path contains `/installs/` (i.e. it points into a retained
 *   `cli/installs/<hash>/...` install root).
 *
 * Paperclip-managed skill entries are absolute symlinks into the active
 * install dir, so an `/installs/` substring is a reliable signal that the
 * link was created (or last re-pointed) by the Paperclip-managed flow.
 * User-installed skills, demo skills, `.bak-*` directories, and external
 * symlinks are never created with `/installs/` in their target — the user
 * flow writes them into arbitrary paths under the skills home directly.
 *
 * The actual re-point is delegated to `syncPiSkills`, which uses the
 * `isStalePaperclipManagedSkillLink` classifier from PR #18 to decide
 * whether the symlink still matches the current source. Symlinks whose
 * target no longer matches the current source get unlinked; everything else
 * is preserved verbatim.
 */
function looksLikeRetainedInstallLink(targetPath: string): boolean {
  const normalized = targetPath.replace(/\\/g, "/");
  return (
    normalized.includes("/installs/") &&
    (normalized.includes("/skills/") || normalized.includes("/skills-releases/"))
  );
}

/**
 * Detect drift in a pi_local agent's skills home without mutating anything.
 *
 * Returns the list of symlink leaf names whose target lives in a retained
 * install root. The caller passes that list (or the agent's stored desired
 * skills, when set) to `syncPiSkills`, which performs the actual re-point.
 */
async function detectPiSkillsHomeDrift(config: Record<string, unknown>): Promise<{
  drifted: boolean;
  driftedNames: string[];
  skillsHome: string;
}> {
  const skillsHome = resolvePiSkillsHome(config);

  let targets: Awaited<ReturnType<typeof readInstalledSkillTargets>>;
  try {
    targets = await readInstalledSkillTargets(skillsHome);
  } catch {
    return { drifted: false, driftedNames: [], skillsHome };
  }

  const driftedNames: string[] = [];
  for (const [name, entry] of targets.entries()) {
    if (entry.kind !== "symlink") continue;
    const targetPath = entry.targetPath;
    if (!targetPath) continue;
    if (looksLikeRetainedInstallLink(targetPath)) {
      driftedNames.push(name);
    }
  }
  return {
    drifted: driftedNames.length > 0,
    driftedNames,
    skillsHome,
  };
}

/**
 * Startup reconciliation: re-point stale Paperclip-managed skill symlinks for
 * pi_local agents after a Paperclip install switch (or any time the active
 * install changes).
 *
 * Why this exists (see JES-251 / JES-248): `cli/current` is repointed to a new
 * install dir on every Paperclip upgrade, and old install dirs are retained.
 * Managed skill entries are absolute symlinks into the install dir, so they
 * silently point at retained-but-old skill content. The plain dangling-link
 * repair (`ensurePaperclipSkillSymlink`) only fires when the target is missing
 * — a live link into a retained old install is `skipped`. The daily watchdog
 * (`JES-248`) is a stopgap; this is the proper lifecycle trigger.
 *
 * Composes with PR #18 (JES-253/JES-289/JES-309 — union-preserving pi_local
 * skill sync + stale-link repair): the trigger invokes `syncPiSkills` with
 * the agent's existing desired skills plus the per-home union of sibling
 * desired skills. Sync stays in add/repair mode only — user-installed entries
 * (different leaf name, paths outside Paperclip install roots) are never
 * classified as drift, matching the PR #18 pruning rules.
 *
 * Fire-safe: wraps each agent in try/catch and logs at warn level on failure.
 */
export async function reconcileManagedSkillLinksOnStartup(
  db: Db,
): Promise<ManagedSkillLinkReconciliationSummary> {
  const summary: ManagedSkillLinkReconciliationSummary = {
    scannedAgents: 0,
    driftedAgents: 0,
    resyncedAgents: 0,
    failedAgents: 0,
    resyncedAgentIds: [],
    emptyHomeAgents: 0,
  };

  const rows = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      adapterType: agents.adapterType,
      adapterConfig: agents.adapterConfig,
    })
    .from(agents)
    .where(eq(agents.adapterType, "pi_local"));

  // Per-home union of desired skills across pi_local siblings sharing the
  // same skills home. Mirrors `resolvePiLocalUnionDesiredSkills` in
  // routes/agents.ts so the sync (which is union-aware per PR #18) prunes
  // nothing another agent still wants.
  const desiredByHome = new Map<string, Set<string>>();
  for (const row of rows) {
    const config = asRecord(row.adapterConfig);
    const home = resolvePiSkillsHome(config);
    const desired = readPaperclipSkillSyncPreference(config).desiredSkills;
    let set = desiredByHome.get(home);
    if (!set) {
      set = new Set<string>();
      desiredByHome.set(home, set);
    }
    for (const key of desired) set.add(key);
  }

  for (const row of rows) {
    summary.scannedAgents += 1;
    const adapterConfig = asRecord(row.adapterConfig);

    let drift;
    try {
      drift = await detectPiSkillsHomeDrift(adapterConfig);
    } catch (err) {
      summary.failedAgents += 1;
      logger.warn(
        {
          agentId: row.id,
          companyId: row.companyId,
          err: err instanceof Error ? err.message : String(err),
        },
        "failed to detect drift in managed skill links on startup",
      );
      continue;
    }

    if (!drift.drifted) continue;

    summary.driftedAgents += 1;
    const preference = readPaperclipSkillSyncPreference(adapterConfig);
    // If the agent never explicitly set desiredSkills, only re-point the
    // drifted names — never auto-install every bundled skill. The PR #18
    // union-aware sync will keep siblings' desired skills alive regardless.
    const effectiveDesired =
      preference.desiredSkills.length > 0 ? preference.desiredSkills : drift.driftedNames;
    const home = resolvePiSkillsHome(adapterConfig);
    const unionSet = desiredByHome.get(home) ?? new Set<string>();
    for (const key of effectiveDesired) unionSet.add(key);
    const unionDesiredSkills = Array.from(unionSet);

    const ctx = {
      agentId: row.id,
      companyId: row.companyId,
      adapterType: row.adapterType as "pi_local",
      config: adapterConfig,
    };

    try {
      await syncPiSkills(ctx, effectiveDesired, { unionDesiredSkills });
      summary.resyncedAgents += 1;
      summary.resyncedAgentIds.push(row.id);
      logger.info(
        {
          agentId: row.id,
          companyId: row.companyId,
          driftedNames: drift.driftedNames,
          skillsHome: drift.skillsHome,
        },
        "re-pointed stale managed skill links after install switch",
      );
    } catch (err) {
      summary.failedAgents += 1;
      logger.warn(
        {
          agentId: row.id,
          companyId: row.companyId,
          driftedNames: drift.driftedNames,
          err: err instanceof Error ? err.message : String(err),
        },
        "failed to re-sync managed skill links after install switch",
      );
    }
  }

  return summary;
}

/**
 * Exposed for unit tests: re-detect drift for a single config without
 * touching the database. Mirrors the per-agent branch of
 * `reconcileManagedSkillLinksOnStartup`.
 */
export const __testing = {
  resolvePiSkillsHome,
  detectPiSkillsHomeDrift,
  looksLikeRetainedInstallLink,
  asRecord,
};