import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { runningProcesses } from "../adapters/utils.js";
import { logActivity } from "./activity-log.js";
import { TERMINAL_HEARTBEAT_RUN_STATUSES } from "./issues.js";
import {
  isPidAlive as defaultIsPidAlive,
  isProcessGroupAlive as defaultIsProcessGroupAlive,
} from "./local-service-supervisor.js";
import { logger } from "../middleware/logger.js";

/**
 * Self-releasing stale checkout locks (JES-338).
 *
 * A dead heartbeat run can hold an issue's `checkoutRunId` lock indefinitely:
 * the passive clearing in `issues.ts` (`clearCheckoutRunIfTerminal`) fires
 * only when someone accesses the issue, and only when the `heartbeatRuns` row
 * is already terminal. Run rows stuck non-terminal while the underlying
 * process is dead (server-restart orphans, dead pids, retry-exhausted runs)
 * hold the lock forever. This sweeper runs on the 15s `executionControlSweeps`
 * tick and releases such locks without any API access to the issue.
 *
 * Sweepable = issue.status is `in_progress` AND `checkoutRunId` is set AND the
 * holding run has been dead for longer than `deadMs`. "Dead" is conservative:
 * a terminal/missing `heartbeatRuns` row (`terminal_row`), or a non-terminal
 * row whose registered local process is observably gone (`dead_process`).
 * Anything uncertain (live handle, live controller lease, live pid/pgid, or
 * no process metadata at all) is skipped, never swept.
 *
 * Dead-age source (deterministic, per-row timestamps, never wall-clock
 * guessing): `terminal_row` uses the run's terminal-transition timestamp
 * (`finishedAt ?? updatedAt`); a missing run row falls back to the issue's
 * `executionLockedAt ?? updatedAt`. `dead_process` uses the run row's
 * `updatedAt` (last recorded run activity) because process death itself
 * leaves no DB timestamp.
 *
 * The release is a short row-locked transaction guarded by the current
 * `checkoutRunId` (compare-and-swap, mirroring `clearCheckoutRunIfTerminal`).
 * Status and assignee are never touched.
 */

export const CHECKOUT_LOCK_SWEEP_BATCH_LIMIT = 100;

/** Default dead-age gate: 30 minutes (see CHECKOUT_LOCK_SWEEP_DEAD_MINUTES). */
export const DEFAULT_CHECKOUT_LOCK_SWEEP_DEAD_MS = 30 * 60 * 1000;

export type CheckoutLockSweepReason = "terminal_row" | "dead_process";

export interface CheckoutLockIssueSnapshot {
  id: string;
  companyId: string;
  status: string;
  checkoutRunId: string | null;
  executionRunId: string | null;
  executionLockedAt: Date | null;
  updatedAt: Date;
}

export interface CheckoutLockRunSnapshot {
  id: string;
  status: string;
  finishedAt: Date | null;
  updatedAt: Date;
  processPid: number | null;
  processGroupId: number | null;
  controllerLeaseExpiresAt: Date | null;
}

export interface CheckoutLockLivenessProbes {
  isPidAlive: (pid: number) => boolean;
  isProcessGroupAlive: (processGroupId: number | null | undefined) => boolean;
  hasLiveHandle: (runId: string) => boolean;
}

export type CheckoutLockVerdict =
  | {
      sweepable: true;
      reason: CheckoutLockSweepReason;
      runId: string;
      deadSince: Date;
      deadAgeMs: number;
    }
  | { sweepable: false; skipReason: string };

function toTime(value: Date | null | undefined): number | null {
  if (!(value instanceof Date)) return null;
  const time = value.getTime();
  return Number.isFinite(time) ? time : null;
}

/**
 * Pure classification: is this checkout lock sweepable right now?
 * Used for the cheap pre-transaction filter and re-evaluated inside the
 * release transaction so a run that finishes inside the sweep window
 * (fresh terminal timestamp, age below the gate) keeps its lock.
 */
export function classifyCheckoutLockForSweep(input: {
  issue: CheckoutLockIssueSnapshot;
  run: CheckoutLockRunSnapshot | null;
  nowMs: number;
  deadMs: number;
  probes: CheckoutLockLivenessProbes;
}): CheckoutLockVerdict {
  const { issue, run, nowMs, deadMs, probes } = input;
  if (issue.status !== "in_progress") {
    return { sweepable: false, skipReason: "not_in_progress" };
  }
  const runId = issue.checkoutRunId;
  if (!runId) {
    return { sweepable: false, skipReason: "no_checkout_run" };
  }

  let reason: CheckoutLockSweepReason;
  let deadSinceMs: number | null;
  if (!run) {
    // The FK nulls checkoutRunId on run-row delete, so this is rare, but a
    // missing row holds no live claim: treat it as a terminal row and age-gate
    // it on the issue's own lock timestamp.
    reason = "terminal_row";
    deadSinceMs =
      toTime(issue.executionLockedAt) ?? toTime(issue.updatedAt);
  } else if (TERMINAL_HEARTBEAT_RUN_STATUSES.has(run.status)) {
    reason = "terminal_row";
    deadSinceMs = toTime(run.finishedAt) ?? toTime(run.updatedAt);
  } else {
    if (probes.hasLiveHandle(run.id)) {
      return { sweepable: false, skipReason: "live_handle" };
    }
    const leaseMs = toTime(run.controllerLeaseExpiresAt);
    if (leaseMs !== null && leaseMs > nowMs) {
      // Another controller may own this run on another host where its pid is
      // still meaningful. Never sweep under a live lease.
      return { sweepable: false, skipReason: "live_controller_lease" };
    }
    const pid = run.processPid;
    const processGroupId = run.processGroupId;
    if (pid === null && processGroupId === null) {
      // No process metadata: liveness is unknowable, so skip rather than risk
      // freeing an issue for a second live run.
      return { sweepable: false, skipReason: "uncertain_liveness" };
    }
    const alive =
      (pid !== null && probes.isPidAlive(pid)) ||
      (processGroupId !== null &&
        probes.isProcessGroupAlive(processGroupId));
    if (alive) {
      return { sweepable: false, skipReason: "live_process" };
    }
    reason = "dead_process";
    deadSinceMs = toTime(run.updatedAt);
  }

  if (deadSinceMs === null) {
    return { sweepable: false, skipReason: "uncertain_dead_age" };
  }
  const deadAgeMs = nowMs - deadSinceMs;
  if (!Number.isFinite(deadAgeMs) || deadAgeMs <= deadMs) {
    return { sweepable: false, skipReason: "below_dead_age_gate" };
  }
  return {
    sweepable: true,
    reason,
    runId,
    deadSince: new Date(deadSinceMs),
    deadAgeMs,
  };
}

export interface SweepStaleCheckoutLocksOptions {
  now?: Date;
  deadMs?: number;
  batchLimit?: number;
  isPidAlive?: (pid: number) => boolean;
  isProcessGroupAlive?: (processGroupId: number | null | undefined) => boolean;
  hasLiveHandle?: (runId: string) => boolean;
  hooks?: {
    /** Test seam: runs after the pre-transaction read, before the release. */
    beforeRelease?: (candidate: {
      issueId: string;
      runId: string;
      reason: CheckoutLockSweepReason;
      deadAgeMs: number;
    }) => Promise<void> | void;
  };
}

export interface SweepStaleCheckoutLocksResult {
  swept: number;
  issueIds: string[];
}

export async function sweepStaleCheckoutLocks(
  db: Db,
  options: SweepStaleCheckoutLocksOptions = {},
): Promise<SweepStaleCheckoutLocksResult> {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const deadMs = options.deadMs ?? DEFAULT_CHECKOUT_LOCK_SWEEP_DEAD_MS;
  const batchLimit = options.batchLimit ?? CHECKOUT_LOCK_SWEEP_BATCH_LIMIT;
  const probes: CheckoutLockLivenessProbes = {
    isPidAlive: options.isPidAlive ?? defaultIsPidAlive,
    isProcessGroupAlive:
      options.isProcessGroupAlive ?? defaultIsProcessGroupAlive,
    hasLiveHandle:
      options.hasLiveHandle ?? ((runId: string) => runningProcesses.has(runId)),
  };

  const result: SweepStaleCheckoutLocksResult = { swept: 0, issueIds: [] };

  const candidates = await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      status: issues.status,
      checkoutRunId: issues.checkoutRunId,
      executionRunId: issues.executionRunId,
      executionLockedAt: issues.executionLockedAt,
      updatedAt: issues.updatedAt,
    })
    .from(issues)
    .where(
      and(eq(issues.status, "in_progress"), isNotNull(issues.checkoutRunId)),
    )
    .orderBy(issues.updatedAt)
    .limit(batchLimit);

  if (candidates.length === 0) return result;

  const referencedRunIds = [
    ...new Set(
      candidates
        .map((issue) => issue.checkoutRunId)
        .filter((id): id is string => !!id),
    ),
  ];
  const runRows =
    referencedRunIds.length > 0
      ? await db
          .select({
            id: heartbeatRuns.id,
            status: heartbeatRuns.status,
            finishedAt: heartbeatRuns.finishedAt,
            updatedAt: heartbeatRuns.updatedAt,
            processPid: heartbeatRuns.processPid,
            processGroupId: heartbeatRuns.processGroupId,
            controllerLeaseExpiresAt: heartbeatRuns.controllerLeaseExpiresAt,
          })
          .from(heartbeatRuns)
          .where(inArray(heartbeatRuns.id, referencedRunIds))
      : [];
  const runById = new Map(runRows.map((row) => [row.id, row]));

  for (const candidate of candidates) {
    const expectedRunId = candidate.checkoutRunId;
    if (!expectedRunId) continue;
    const precheck = classifyCheckoutLockForSweep({
      issue: candidate,
      run: runById.get(expectedRunId) ?? null,
      nowMs,
      deadMs,
      probes,
    });
    if (!precheck.sweepable) continue;

    await options.hooks?.beforeRelease?.({
      issueId: candidate.id,
      runId: precheck.runId,
      reason: precheck.reason,
      deadAgeMs: precheck.deadAgeMs,
    });

    // Short transaction: re-read under a row lock and re-evaluate, so a lock
    // released/adopted concurrently, or a run that finished inside the sweep
    // window, is never clobbered.
    const released = await db.transaction(async (tx) => {
      const locked = await tx
        .select({
          id: issues.id,
          companyId: issues.companyId,
          status: issues.status,
          checkoutRunId: issues.checkoutRunId,
          executionRunId: issues.executionRunId,
          executionLockedAt: issues.executionLockedAt,
          updatedAt: issues.updatedAt,
        })
        .from(issues)
        .where(eq(issues.id, candidate.id))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (
        !locked ||
        locked.status !== "in_progress" ||
        locked.checkoutRunId !== expectedRunId
      ) {
        return null;
      }
      const currentRun = await tx
        .select({
          id: heartbeatRuns.id,
          status: heartbeatRuns.status,
          finishedAt: heartbeatRuns.finishedAt,
          updatedAt: heartbeatRuns.updatedAt,
          processPid: heartbeatRuns.processPid,
          processGroupId: heartbeatRuns.processGroupId,
          controllerLeaseExpiresAt: heartbeatRuns.controllerLeaseExpiresAt,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, expectedRunId))
        .then((rows) => rows[0] ?? null);
      const verdict = classifyCheckoutLockForSweep({
        issue: locked,
        run: currentRun,
        nowMs,
        deadMs,
        probes,
      });
      if (!verdict.sweepable) return null;

      const updated = await tx
        .update(issues)
        .set({
          checkoutRunId: null,
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(issues.id, candidate.id),
            eq(issues.checkoutRunId, expectedRunId),
            locked.executionRunId
              ? eq(issues.executionRunId, locked.executionRunId)
              : isNull(issues.executionRunId),
          ),
        )
        .returning({ id: issues.id })
        .then((rows) => rows[0] ?? null);
      if (!updated) return null;
      return verdict;
    });

    if (!released) continue;

    result.swept += 1;
    result.issueIds.push(candidate.id);
    await logActivity(db, {
      companyId: candidate.companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.checkout_lock_swept",
      entityType: "issue",
      entityId: candidate.id,
      runId: released.runId,
      details: {
        source: "checkout-lock-sweeper.sweep_stale_checkout_locks",
        issueId: candidate.id,
        runId: released.runId,
        deadAgeMs: released.deadAgeMs,
        reason: released.reason,
      },
    });
  }

  if (result.swept > 0) {
    logger.warn(
      { swept: result.swept, issueIds: result.issueIds },
      "checkout-lock sweeper released stale checkout locks",
    );
  }

  return result;
}
