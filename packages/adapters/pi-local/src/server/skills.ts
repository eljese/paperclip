import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterSkillContext,
  AdapterSkillSnapshot,
  AdapterSkillSyncOptions,
} from "@paperclipai/adapter-utils";
import {
  buildPersistentSkillSnapshot,
  ensurePaperclipSkillSymlink,
  isStalePaperclipManagedSkillLink,
  readPaperclipRuntimeSkillEntries,
  readInstalledSkillTargets,
  resolveLegacyPaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resolvePiSkillsHome(config: Record<string, unknown>) {
  const env =
    typeof config.env === "object" && config.env !== null && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  const configuredHome = asString(env.HOME);
  const home = configuredHome ? path.resolve(configuredHome) : os.homedir();
  return path.join(home, ".pi", "agent", "skills");
}

async function buildPiSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
  const skillsHome = resolvePiSkillsHome(config);
  const installed = await readInstalledSkillTargets(skillsHome);
  return buildPersistentSkillSnapshot({
    adapterType: "pi_local",
    availableEntries,
    desiredSkills,
    installed,
    skillsHome,
    locationLabel: "~/.pi/agent/skills",
    missingDetail: "Configured but not currently linked into the Pi skills home.",
    externalConflictDetail: "Skill name is occupied by an external installation.",
    externalDetail: "Installed outside Paperclip management.",
  });
}

export async function listPiSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildPiSkillSnapshot(ctx.config);
}

export async function syncPiSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
  options?: AdapterSkillSyncOptions,
): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(ctx.config, __moduleDir);
  const desiredSet = new Set([
    ...resolveLegacyPaperclipDesiredSkillNames({}, availableEntries),
    ...desiredSkills,
  ]);
  // Union of desired keys across every pi_local agent sharing this skills
  // home. Pruning consults the union so one agent's sync never removes a
  // skill another agent still wants. Absent (single-agent) falls back to
  // the per-agent set, preserving prior behavior exactly.
  const unionSet = new Set(desiredSet);
  for (const key of options?.unionDesiredSkills ?? []) unionSet.add(key);
  const skillsHome = resolvePiSkillsHome(ctx.config);
  await fs.mkdir(skillsHome, { recursive: true });
  const installed = await readInstalledSkillTargets(skillsHome);
  const availableByRuntimeName = new Map(availableEntries.map((entry) => [entry.runtimeName, entry]));

  for (const available of availableEntries) {
    if (!desiredSet.has(available.key)) continue;
    const target = path.join(skillsHome, available.runtimeName);
    await ensurePaperclipSkillSymlink(available.source, target);
  }

  for (const [name, installedEntry] of installed.entries()) {
    const available = availableByRuntimeName.get(name);
    // Unknown names (.bak-* dirs, demo-skill, user installs) are never touched.
    if (!available) continue;
    // Desired by somebody in the union: keep, even if this agent dropped it.
    if (unionSet.has(available.key)) continue;
    // Prune only Paperclip-managed links: exact current-source matches plus
    // stale links into retained old install roots. Live external symlinks
    // (different leaf name or outside skill roots) are left alone.
    if (installedEntry.kind !== "symlink") continue;
    const targetPath = installedEntry.targetPath;
    if (targetPath === available.source) {
      await fs.unlink(path.join(skillsHome, name)).catch(() => {});
      continue;
    }
    if (
      targetPath &&
      isStalePaperclipManagedSkillLink(targetPath, available.source)
    ) {
      await fs.unlink(path.join(skillsHome, name)).catch(() => {});
    }
  }

  return buildPiSkillSnapshot(ctx.config);
}

export function resolvePiDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string }>,
) {
  return resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);
}
