/**
 * Host-OOM attribution + cause-aware retry policy (JES-342).
 *
 * When the host (Hermes VM) is under sustained memory pressure, the kernel
 * OOM killer terminates `paperclipai.service` and all in-flight pi child
 * processes with the cgroup (SIGTERM -> exit 143, or abrupt pid-gone).
 * Those deaths are infrastructure faults, not agent faults. They must:
 *  - settle with a distinct error_code (`host_oom_kill`) instead of the
 *    generic `process_lost` / `adapter_failed` / `orphaned_running_run`,
 *  - retry with exponential backoff (2m -> 8m -> 30m) on a separate
 *    infra-retry budget that does NOT consume the bounded failure budget,
 *  - pause new dispatch while host-OOM pressure is active.
 *
 * All detection here is best-effort and never throws: when systemd/cgroup
 * info is unavailable (non-Linux dev envs, tests, containers) it degrades to
 * "no OOM" and settlement proceeds unchanged.
 */
import {
  existsSync as defaultExistsSync,
  readFileSync as defaultReadFileSync,
  statSync as defaultStatSync,
} from "node:fs";

export const HOST_OOM_ERROR_CODE = "host_oom_kill" as const;
export const HOST_OOM_RETRY_REASON = "host_oom_retry" as const;
export const HOST_OOM_RETRY_WAKE_REASON = "host_oom_retry" as const;

export const HOST_OOM_RETRY_DELAYS_MS = [120_000, 480_000, 1_800_000] as const;
export const HOST_OOM_MAX_ATTEMPTS = HOST_OOM_RETRY_DELAYS_MS.length;

/** How long after an OOM marker/cgroup signal we still treat the host as pressured. */
export const HOST_OOM_ACTIVE_WINDOW_MS = 30 * 60_000;

const GENERIC_INFRA_DEATH_CODES = new Set<string>([
  "process_lost",
  "adapter_failed",
  "orphaned_running_run",
  "orphaned_running_run_issue_terminal",
]);

export function isGenericInfraDeathCode(code: string | null | undefined): boolean {
  return typeof code === "string" && GENERIC_INFRA_DEATH_CODES.has(code);
}

export function isHostOomRetryEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env.PAPERCLIP_HOST_OOM_RETRY_ENABLED?.trim().toLowerCase();
  // Feature flag for the retry policy only (attribution is write-only metadata
  // and always on). Set to "0"/"false"/"no"/"off" to fall back to legacy 30s
  // bounded retries even for OOM-attributed runs.
  return raw !== "0" && raw !== "false" && raw !== "no" && raw !== "off";
}

export function readHostOomEnvOverride(
  env: Record<string, string | undefined> = process.env,
): boolean | null {
  const raw = env.PAPERCLIP_HOST_OOM_ACTIVE?.trim().toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  return null;
}

/**
 * Attribute a generic infra-death code to host-OOM when pressure is active.
 * Returns the original code unchanged for non-OOM failures (no behavior change),
 * for specific non-generic codes (validation, auth, quota, ...), and when OOM
 * is not active. Never throws.
 */
export function attributeHostOomErrorCode(
  originalCode: string,
  oomActive: boolean,
  opts?: { exitCode?: number | null; signal?: string | null },
): string {
  try {
    if (!oomActive) return originalCode;
    if (originalCode === HOST_OOM_ERROR_CODE) return originalCode;
    if (!isGenericInfraDeathCode(originalCode)) return originalCode;
    // Exit 143 (128+15 SIGTERM) is the classic cgroup-wide SIGTERM teardown
    // signature of a host-OOM kill. When OOM pressure is active we attribute
    // any generic infra death (including non-143) to keep the signal strong;
    // the exit/signal is preserved in the run event payload by callers.
    void opts;
    return HOST_OOM_ERROR_CODE;
  } catch {
    return originalCode;
  }
}

export function computeHostOomRetrySchedule(
  attempt: number,
  now: Date = new Date(),
): {
  attempt: number;
  baseDelayMs: number;
  delayMs: number;
  dueAt: Date;
  maxAttempts: number;
} | null {
  if (!Number.isInteger(attempt) || attempt <= 0) return null;
  const baseDelayMs = HOST_OOM_RETRY_DELAYS_MS[attempt - 1];
  if (typeof baseDelayMs !== "number") return null;
  return {
    attempt,
    baseDelayMs,
    delayMs: baseDelayMs,
    dueAt: new Date(now.getTime() + baseDelayMs),
    maxAttempts: HOST_OOM_MAX_ATTEMPTS,
  };
}

/** Parse cgroup v2 `memory.events` content for the `oom_kill` counter. */
export function readMemoryEventsOomKill(content: string): number | null {
  try {
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("oom_kill")) continue;
      const parts = trimmed.split(/\s+/);
      const value = Number(parts[1]);
      if (Number.isSafeInteger(value) && value >= 0) return value;
    }
    return null;
  } catch {
    return null;
  }
}

export interface HostOomFs {
  existsSync?: (path: string) => boolean;
  readFileSync?: (path: string, encoding: "utf8") => string;
  statSync?: (path: string) => { mtimeMs: number };
}

export interface HostOomActiveResult {
  active: boolean;
  reason: "env_override" | "marker_file" | "cgroup_oom_kill" | null;
}

function defaultMemoryEventsPaths(
  env: Record<string, string | undefined>,
): string[] {
  const override = env.PAPERCLIP_HOST_OOM_MEMORY_EVENTS_PATH?.trim();
  const candidates = [
    ...(override ? [override] : []),
    "/sys/fs/cgroup/system.slice/paperclipai.service/memory.events",
    "/sys/fs/cgroup/user.slice/user-3000.slice/user@3000.service/app.slice/paperclipai.service/memory.events",
    "/sys/fs/cgroup/memory.events",
  ];
  return [...new Set(candidates.filter(Boolean))];
}

function defaultMarkerPaths(
  env: Record<string, string | undefined>,
): string[] {
  const override = env.PAPERCLIP_HOST_OOM_MARKER_FILE?.trim();
  return [...new Set([...(override ? [override] : []),
    "/run/paperclipai/host-oom",
    "/tmp/paperclipai-host-oom",
  ])];
}

/**
 * Best-effort host-OOM pressure check. Never throws; returns inactive when
 * systemd/cgroup info is unavailable. Order: env override -> marker file ->
 * cgroup memory.events oom_kill with mtime recency window.
 */
export function isHostOomActive(
  opts: {
    env?: Record<string, string | undefined>;
    fs?: HostOomFs;
    nowMs?: number;
    activeWindowMs?: number;
  } = {},
): HostOomActiveResult {
  try {
    const env = opts.env ?? process.env;
    const override = readHostOomEnvOverride(env);
    if (override !== null) {
      return { active: override, reason: override ? "env_override" : null };
    }
    const activeWindowMs = opts.activeWindowMs ?? HOST_OOM_ACTIVE_WINDOW_MS;
    const nowMs = opts.nowMs ?? Date.now();
    const existsSync = opts.fs?.existsSync ?? defaultExistsSync;
    const readFileSync = (opts.fs?.readFileSync ?? defaultReadFileSync) as (
      path: string,
      encoding: "utf8",
    ) => string;
    const statSync = (opts.fs?.statSync ?? defaultStatSync) as (
      path: string,
    ) => { mtimeMs: number };
    if (!existsSync || !readFileSync || !statSync) {
      return { active: false, reason: null };
    }
    for (const marker of defaultMarkerPaths(env)) {
      try {
        if (!existsSync(marker)) continue;
        const stat = statSync(marker);
        if (
          Number.isFinite(stat.mtimeMs) &&
          nowMs - stat.mtimeMs <= activeWindowMs
        ) {
          return { active: true, reason: "marker_file" };
        }
      } catch {
        continue;
      }
    }
    for (const eventsPath of defaultMemoryEventsPaths(env)) {
      try {
        if (!existsSync(eventsPath)) continue;
        const content = readFileSync(eventsPath, "utf8");
        const oomKill = readMemoryEventsOomKill(content);
        if (oomKill === null || oomKill <= 0) continue;
        const stat = statSync(eventsPath);
        if (
          Number.isFinite(stat.mtimeMs) &&
          nowMs - stat.mtimeMs <= activeWindowMs
        ) {
          return { active: true, reason: "cgroup_oom_kill" };
        }
      } catch {
        continue;
      }
    }
    return { active: false, reason: null };
  } catch {
    return { active: false, reason: null };
  }
}

/** Dispatch-guard predicate: true while host-OOM pressure is active. Never throws. */
export function shouldSuppressDispatchDueToHostOom(
  opts: {
    env?: Record<string, string | undefined>;
    fs?: HostOomFs;
    nowMs?: number;
  } = {},
): boolean {
  try {
    return isHostOomActive(opts).active;
  } catch {
    return false;
  }
}
