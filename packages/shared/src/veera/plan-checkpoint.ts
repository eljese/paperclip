/**
 * Veera T3 — plan-checkpoint skill (JES-156, PRD section 6).
 *
 * For every active mandatory pre-release requirement, verifies:
 *  (a) the contract preserves the source commitment (non-empty sourceLocations);
 *  (b) planned work credibly covers the acceptance criteria (non-empty,
 *      non-blank `planRefs` — missing plan coverage blocks handoff, AC-03);
 *  (c) a practical verification method exists (`verificationMethod` plus an
 *      environment-access note).
 *
 * Post-deployment requirements need a planned method + owner + completion
 * gate — never impossible pre-deployment production evidence.
 *
 * Pure and deterministic: no clock, no randomness, no I/O.
 */

import type { Requirement } from "./types.js";
import type { PlanFinalDecision } from "./source-completeness.js";

export type ReleasePhase = "pre" | "post";

export interface PlanCheckpointInput extends Requirement {
  /** Pre-release (verified at final checkpoint) or post-deployment. */
  releasePhase: ReleasePhase;
  /** Where the check can run, e.g. "CI linux runner with repo checkout". */
  environmentAccess?: string;
  /** Post-deployment only: owner responsible for the post-deployment check. */
  owner?: string;
  /** Post-deployment only: gate that completes the requirement after deploy. */
  completionGate?: string;
}

export interface PlanCheckpointFinding {
  requirementId: string;
  decision: PlanFinalDecision;
  reasons: string[];
}

export interface PlanCheckpointResult {
  decision: PlanFinalDecision;
  findings: PlanCheckpointFinding[];
}

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}

function hasCrediblePlanRefs(planRefs: string[] | undefined): boolean {
  if (planRefs === undefined) return false;
  return planRefs.some((p) => p.trim().length > 0);
}

function checkOne(input: PlanCheckpointInput): PlanCheckpointFinding {
  const reasons: string[] = [];
  const id = input.id;

  if (input.lifecycle !== "active") {
    return { requirementId: id, decision: "PASS", reasons: [] };
  }

  if (input.classification !== "mandatory") {
    return { requirementId: id, decision: "PASS", reasons: [] };
  }

  if (input.releasePhase === "post") {
    if (isBlank(input.verificationMethod)) {
      reasons.push(`post-deployment ${id} has no planned verification method`);
    }
    if (isBlank(input.owner)) {
      reasons.push(`post-deployment ${id} has no owner`);
    }
    if (isBlank(input.completionGate)) {
      reasons.push(`post-deployment ${id} has no completion gate`);
    }
    return { requirementId: id, decision: reasons.length === 0 ? "PASS" : "HOLD", reasons };
  }

  // Pre-release mandatory requirement.
  if (input.sourceLocations.length === 0) {
    reasons.push(`${id} has no source commitment preserved in the contract`);
  }
  if (!hasCrediblePlanRefs(input.planRefs)) {
    reasons.push(`${id} has no credible plan coverage (missing planRefs blocks handoff)`);
  }
  if (isBlank(input.verificationMethod)) {
    reasons.push(`${id} has no practical verification method`);
  } else if (isBlank(input.environmentAccess)) {
    reasons.push(`${id} verification method has no environment-access note`);
  }

  return { requirementId: id, decision: reasons.length === 0 ? "PASS" : "HOLD", reasons };
}

/** Runs the plan checkpoint over all inputs; any HOLD finding yields HOLD. */
export function assessPlanCheckpoint(inputs: PlanCheckpointInput[]): PlanCheckpointResult {
  const findings = inputs.map(checkOne);
  return {
    decision: findings.some((f) => f.decision === "HOLD") ? "HOLD" : "PASS",
    findings,
  };
}

/** Missing plan coverage blocks the implementation handoff. */
export function blocksHandoff(result: PlanCheckpointResult): boolean {
  return result.decision !== "PASS";
}
