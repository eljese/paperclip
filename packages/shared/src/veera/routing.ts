/**
 * Veera T3 — HOLD routing + correction budget (JES-156, PRD section 10).
 *
 * Routing table: missing/incorrect behavior -> engineer correction; missing
 * evidence -> QA/evidence producer; ambiguous scope -> scope authority;
 * tool/credential/env/quota unavailable -> operational owner + blocked state;
 * malformed/stale publication -> publisher/integration owner.
 *
 * ONE shared delivery-level correction budget (Ahti-CTO ledger model:
 * attempt-zero + max 2 automatic rounds). The 2-round default applies when no
 * policy exists — the default fallback stays in code. Budget exhaustion NEVER
 * flips HOLD to PASS; it escalates instead.
 *
 * Local execution stops after 2 consecutive no-progress iterations and
 * reports the blocker; new sessions must NOT silently reset the counter.
 * Dedup key = (delivery, checkpoint, contract hash, candidate/plan identity):
 * duplicate triggers must not create parallel audits or correction tasks
 * (AC-13). Consumption persists across tasks/sessions/candidates/model
 * switches (the ledger is passed in, never session-local).
 *
 * Finite infra retries (owns T1 blocker B4): MAX_INFRA_RETRIES = 3, then
 * blocked-state escalation. Infra retries never count as product progress and
 * never mint budget.
 *
 * Pure and deterministic: no clock, no randomness, no I/O.
 */

export const DEFAULT_MAX_AUTOMATIC_CORRECTIONS = 2 as const;
export const MAX_CONSECUTIVE_NO_PROGRESS = 2 as const;
/** B4: explicit finite infra-retry count (this task owns it). */
export const MAX_INFRA_RETRIES = 3 as const;

export type HoldCategory =
  | "missing_behavior"
  | "incorrect_behavior"
  | "missing_evidence"
  | "ambiguous_scope"
  | "unavailable_tool_env"
  | "malformed_publication";

export type HoldOwner =
  | "engineer"
  | "qa-evidence-producer"
  | "scope-authority"
  | "operational-owner"
  | "publisher-integration-owner";

export const HOLD_ROUTING_TABLE: Record<HoldCategory, HoldOwner> = {
  missing_behavior: "engineer",
  incorrect_behavior: "engineer",
  missing_evidence: "qa-evidence-producer",
  ambiguous_scope: "scope-authority",
  unavailable_tool_env: "operational-owner",
  malformed_publication: "publisher-integration-owner",
};

/** Categories that force the delivery into blocked state (not just correction). */
export function isBlockedCategory(category: HoldCategory): boolean {
  return category === "unavailable_tool_env";
}

/** Routes a HOLD category to its owner. Total function over the table. */
export function routeHold(category: HoldCategory): HoldOwner {
  return HOLD_ROUTING_TABLE[category];
}

export interface CorrectionLedger {
  /** Delivery this ledger belongs to (single shared delivery-level budget). */
  deliveryId: string;
  /** Automatic correction rounds consumed so far (attempt-zero excluded). */
  consumedAutomaticRounds: number;
  /** Max automatic rounds; defaults to 2 when no policy exists. */
  maxAutomaticRounds?: number;
  /** Consecutive no-progress iterations (survives session restarts via the ledger). */
  consecutiveNoProgress: number;
  /** Infra retries used for the current operation (B4, max 3). */
  infraRetriesUsed?: number;
}

export interface CorrectionDecision {
  /** Whether another automatic correction round may run. */
  allowed: boolean;
  /** True when the HOLD must escalate (budget exhausted) — never flips to PASS. */
  escalate: boolean;
  /** True when local execution must stop and report the blocker. */
  stopAndReportBlocker: boolean;
  /** Remaining automatic rounds (never negative). */
  remaining: number;
}

export function maxAutomaticRounds(ledger: CorrectionLedger): number {
  return ledger.maxAutomaticRounds ?? DEFAULT_MAX_AUTOMATIC_CORRECTIONS;
}

/**
 * Consumes one correction round against the shared delivery-level ledger.
 * `progress: false` records a no-progress iteration. After 2 consecutive
 * no-progress iterations local execution stops and reports the blocker.
 * Budget exhaustion escalates; it never flips HOLD to PASS.
 */
export function consumeCorrectionRound(
  ledger: CorrectionLedger,
  progress: boolean,
): { ledger: CorrectionLedger; decision: CorrectionDecision } {
  const max = maxAutomaticRounds(ledger);
  const consecutiveNoProgress = progress ? 0 : ledger.consecutiveNoProgress + 1;
  const consumedAutomaticRounds = ledger.consumedAutomaticRounds + 1;
  const remaining = Math.max(0, max - consumedAutomaticRounds);
  const exhausted = consumedAutomaticRounds >= max;
  const stopAndReportBlocker = consecutiveNoProgress >= MAX_CONSECUTIVE_NO_PROGRESS;
  const next: CorrectionLedger = {
    ...ledger,
    consumedAutomaticRounds,
    consecutiveNoProgress,
  };
  return {
    ledger: next,
    decision: {
      allowed: !exhausted,
      escalate: exhausted,
      stopAndReportBlocker,
      remaining,
    },
  };
}

/**
 * Records an infra retry (B4). Returns `retry: true` while retries remain,
 * else `blocked: true` for blocked-state escalation. Infra retries never
 * touch the product correction budget.
 */
export function recordInfraRetry(ledger: CorrectionLedger): {
  ledger: CorrectionLedger;
  retry: boolean;
  blocked: boolean;
} {
  const used = (ledger.infraRetriesUsed ?? 0) + 1;
  const next: CorrectionLedger = { ...ledger, infraRetriesUsed: used };
  if (used <= MAX_INFRA_RETRIES) {
    return { ledger: next, retry: true, blocked: false };
  }
  return { ledger: next, retry: false, blocked: true };
}

/**
 * Dedup key: (delivery, checkpoint, contract hash, candidate/plan identity).
 * Duplicate triggers with the same key must not create parallel audits or
 * correction tasks.
 */
export function dedupKey(
  deliveryId: string,
  checkpoint: "plan" | "final",
  contractHash: string,
  candidateOrPlanIdentity: string,
): string {
  return [deliveryId, checkpoint, contractHash, candidateOrPlanIdentity].join("|");
}

/** Returns true when an audit/correction task should be created (key unseen). */
export function shouldCreateTask(seenKeys: ReadonlySet<string>, key: string): boolean {
  return !seenKeys.has(key);
}
