import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  isStalePaperclipManagedSkillLink,
  readInstalledSkillTargets,
  readPaperclipRuntimeSkillEntries,
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
 * exactly — except for the persisted-binding handling documented below.
 *
 * The reconciliation groups agents by skills home so the union of desired
 * skills (passed to `syncPiSkills` as `unionDesiredSkills`) matches the
 * per-home sibling set the explicit POST /agents/:id/skills/sync endpoint
 * computes. Centralizing the helper here keeps both paths in lock-step.
 *
 * Persisted-binding handling (JES-251 correction #2, addresses the
 * [JES-421](/JES/issues/JES-421) P1 found by pre-merge QA on PR #23): the
 * runtime path (manual skills sync) flattens env bindings to plain strings
 * via `resolveAdapterConfigForRuntime`. The startup path here reads raw
 * agent rows, where `env.HOME` may be a binding object of the form
 * `{type:"plain", value:"..."}` (legacy plaintext is also accepted as a
 * plain string). For plain bindings we extract `.value` directly; for
 * `secret_ref` / `user_secret_ref` we cannot resolve without the secrets
 * service, so we log at warn and fall back to the server process home —
 * which is the documented fail-closed behavior for unrecoverable
 * bindings and matches the rest of the platform's startup-time access
 * path (the secrets service isn't yet available to the boot
 * reconciliation).
 */
function resolvePiSkillsHome(config: Record<string, unknown>): string {
  const env = asRecord(config.env);
  const raw = env.HOME;
  const plain = readEnvBindingAsPlainString(raw, "HOME");
  const home = plain ? path.resolve(plain) : os.homedir();
  return path.join(home, ".pi", "agent", "skills");
}

/**
 * Pre-flatten persisted env bindings in an agent config to plain strings.
 * Mirrors what `resolveAdapterConfigForRuntime` does for the manual
 * skills-sync path, but at startup without the secrets service: we can
 * only resolve `plain` bindings (which carry the value directly). For
 * `secret_ref` / `user_secret_ref` the value is opaque without the
 * secrets service, so we leave those bindings untouched — the caller
 * (adapter's `resolvePiSkillsHome`) will then see the binding object
 * and fall back to its own home, missing the agent's skills. That's
 * the documented fail-closed posture and the binding detector already
 * filtered such agents into the no-drift path.
 *
 * Returns a shallow-cloned config with a fresh `env` record; non-env
 * fields are passed through by reference.
 */
function flattenEnvBindingsForRuntimeSync(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const env = asRecord(config.env);
  const next: Record<string, unknown> = {};
  let changed = false;
  for (const [key, raw] of Object.entries(env)) {
    const plain = readEnvBindingAsPlainStringSilent(raw);
    if (plain !== null) {
      next[key] = plain;
      if (raw !== plain) changed = true;
    } else {
      next[key] = raw;
    }
  }
  if (!changed && Object.keys(next).length === Object.keys(env).length) {
    return config;
  }
  return { ...config, env: next };
}

function readEnvBindingAsPlainStringSilent(raw: unknown): string | null {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    if (record.type === "plain" && typeof record.value === "string") {
      const trimmed = record.value.trim();
      return trimmed ? trimmed : null;
    }
  }
  return null;
}

/**
 * Read an env binding value as a plain string. Accepts:
 *   - a plain string (legacy plaintext, backward-compatible);
 *   - an object `{type:"plain", value:"..."}` (current canonical shape
 *     written by `normalizeEnvConfig` on every create/update).
 *
 * Returns `null` for missing/empty inputs and for binding types whose
 * resolution requires the secrets service at runtime
 * (`secret_ref`, `user_secret_ref`). Callers log the gap at warn level
 * and fall back; this matches the platform's startup-time posture
 * (no secrets service available to the boot reconciliation).
 */
function readEnvBindingAsPlainString(
  raw: unknown,
  key: string,
): string | null {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    if (record.type === "plain" && typeof record.value === "string") {
      const trimmed = record.value.trim();
      return trimmed ? trimmed : null;
    }
    if (record.type === "secret_ref" || record.type === "user_secret_ref") {
      logger.warn(
        { envKey: key, bindingType: record.type },
        "managed-skill-link reconciliation cannot resolve secret_ref/user_secret_ref env binding at startup; falling back to server home",
      );
      return null;
    }
  }
  return null;
}

/**
 * Detect drift by comparing each managed link's resolved target with the
 * current bundled source for that runtime skill. Uses the same
 * `isStalePaperclipManagedSkillLink` classifier PR #18 ships for
 * `syncPiSkills`, so the pre-check and the eventual repair agree on the
 * staleness definition:
 *
 *   A symlink is stale iff (a) its basename matches a known runtime
 *   skill's basename, (b) its target differs from the current source, and
 *   (c) both the target and the source look like Paperclip-managed skill
 *   paths (`/skills/`, `/installs/`, or `/skills-releases/`).
 *
 * This avoids the prior path-shape heuristic, which misclassified any link
 * whose target contained `/installs/` + `/skills/` as drift — current
 * Paperclip-managed links under `cli/installs/<current-hash>/.../skills/...`
 * were flagged on every startup, triggering a no-op sync that still cost log
 * noise and (more importantly) stopped the per-home union from short-circuiting
 * once a sibling agent had already re-pointed a shared-home link.
 */

/**
 * Detect drift in a pi_local agent's skills home without mutating anything.
 *
 * Returns the list of symlink leaf names whose target diverges from the
 * current bundled source for that runtime skill into a retained old install
 * (using PR #18's `isStalePaperclipManagedSkillLink` classifier). The caller
 * passes that list (or the agent's stored desired skills, when set) to
 * `syncPiSkills`, which performs the actual re-point.
 *
 * Symlinks whose target already matches the current source exactly are NOT
 * reported as drift — `isStalePaperclipManagedSkillLink` short-circuits on
 * equality. This is the key invariant: once any sibling agent's startup
 * sync has re-pointed a shared-home link at the current source, subsequent
 * sibling detections see no drift and skip their sync entirely, preserving
 * the union without redundant re-passes.
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

  let availableEntries: Awaited<ReturnType<typeof readPaperclipRuntimeSkillEntries>>;
  try {
    availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  } catch {
    return { drifted: false, driftedNames: [], skillsHome };
  }

  // Map runtime leaf name → current bundled source. Symlinks whose leaf
  // name isn't in this map are not Paperclip-managed (user-installed,
  // demo, .bak-*, etc.) and are never classified as drift.
  const sourceByName = new Map<string, string>();
  for (const entry of availableEntries) {
    if (!entry.runtimeName || !entry.source) continue;
    sourceByName.set(entry.runtimeName, entry.source);
  }

  const driftedNames: string[] = [];
  for (const [name, entry] of targets.entries()) {
    if (entry.kind !== "symlink") continue;
    const targetPath = entry.targetPath;
    if (!targetPath) continue;
    const currentSource = sourceByName.get(name);
    if (!currentSource) continue;
    if (isStalePaperclipManagedSkillLink(targetPath, currentSource)) {
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

    // Pre-flatten persisted env bindings to plain strings before handing
    // the config to `syncPiSkills`. The pi_local adapter's internal
    // `resolvePiSkillsHome` (PR #18) only reads plain-string `env.HOME`,
    // so without this pre-flatten the sync would scan the wrong home
    // and never reach the agent's actual managed-skill directory.
    // For plain bindings we extract `.value`; for non-plain bindings we
    // cannot resolve at startup (no secrets service) — the detector
    // already filtered those into the no-drift path, so we should not
    // reach here with a non-plain HOME. Defensive fallback: leave env
    // as-is and let the adapter fall back to its own home (which will
    // miss the agent's links; logged at warn above).
    const ctx = {
      agentId: row.id,
      companyId: row.companyId,
      adapterType: row.adapterType as "pi_local",
      config: flattenEnvBindingsForRuntimeSync(adapterConfig),
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
  readEnvBindingAsPlainString,
  readEnvBindingAsPlainStringSilent,
  flattenEnvBindingsForRuntimeSync,
  asRecord,
};