/**
 * Veera T3 — final-checkpoint skill (JES-156, PRD section 7).
 *
 * Per-requirement PASS / PARTIAL / MISSING / UNCERTAIN assessment.
 * Evidence records must carry requirement/criterion, source path or artifact,
 * method, outcome, durable ref, AND candidate/build identity. Missing or
 * wrong-build evidence yields UNCERTAIN, never PASS (AC-05).
 *
 * Rules:
 *  - any PARTIAL / MISSING / UNCERTAIN mandatory result yields HOLD;
 *  - advisory gaps are reported without blocking;
 *  - a missing report (no findings for a due mandatory requirement) yields HOLD.
 *
 * Trustworthy QA/CI results may be reused after inspecting what they test: a
 * candidate-bound relevant passing test may pass WITHOUT a full QA rerun
 * (AC-05). Carry-forward of previous evidence requires an explicit
 * applicability assessment plus sound candidate binding — a new SHA never
 * inherits approval.
 *
 * Post-deployment requirements: a pre-release PASS authorizes deployment
 * ONLY; parent completion stays blocked until post-deployment checks pass for
 * the deployed artifact (AC-11 support).
 *
 * Pure and deterministic: no clock, no randomness, no I/O.
 */

import type { AuditEvidence, AuditResult } from "./types.js";
import type { PlanFinalDecision } from "./source-completeness.js";
import type { ReleasePhase } from "./plan-checkpoint.js";

export interface FinalCheckpointRequirement {
  id: string;
  classification: "mandatory" | "advisory";
  lifecycle: "active" | "removed" | "superseded";
  releasePhase: ReleasePhase;
  acceptanceCriteria: string[];
}

/**
 * A previously recorded evidence item reused for this checkpoint.
 * `inspectedWhatItTests` records that Veera inspected what the QA/CI check
 * actually tests; `applicabilityNote` records the explicit applicability
 * assessment required for carry-forward across candidates.
 */
export interface ReusedEvidence {
  evidence: AuditEvidence;
  inspectedWhatItTests: boolean;
  relevant: boolean;
  passing: boolean;
  applicabilityNote?: string;
}

export interface FinalCheckpointFinding {
  requirementId: string;
  result: AuditResult;
  note?: string;
}

export interface FinalCheckpointResult {
  decision: PlanFinalDecision;
  /** True when deployment is authorized but parent completion stays blocked. */
  deploymentOnly: boolean;
  findings: FinalCheckpointFinding[];
}

function evidenceBoundToCandidate(evidence: AuditEvidence, candidateSha: string): boolean {
  return evidence.candidateOrBuildIdentity.includes(candidateSha);
}

function evidenceComplete(evidence: AuditEvidence): boolean {
  return (
    evidence.requirementId.trim().length > 0 &&
    evidence.criterion.trim().length > 0 &&
    evidence.sourcePathOrArtifact.trim().length > 0 &&
    evidence.method.trim().length > 0 &&
    evidence.outcome.trim().length > 0 &&
    evidence.durableRef.trim().length > 0 &&
    evidence.candidateOrBuildIdentity.trim().length > 0
  );
}

/**
 * Assesses a single requirement from its evidence items.
 * Missing or wrong-build evidence yields UNCERTAIN, never PASS.
 */
export function assessRequirementEvidence(
  requirementId: string,
  items: AuditEvidence[],
  candidateSha: string,
): AuditResult {
  if (items.length === 0) return "MISSING";
  let sawWeak = false;
  for (const item of items) {
    if (!evidenceComplete(item)) return "UNCERTAIN";
    if (item.requirementId !== requirementId) return "UNCERTAIN";
    if (!evidenceBoundToCandidate(item, candidateSha)) return "UNCERTAIN";
    const outcome = item.outcome.trim().toLowerCase();
    if (outcome === "fail" || outcome === "failed" || outcome === "mismatch") {
      return "PARTIAL";
    }
    if (outcome === "partial" || outcome === "unclear") sawWeak = true;
  }
  return sawWeak ? "PARTIAL" : "PASS";
}

/**
 * Assesses a reused QA/CI result: it may pass WITHOUT a full QA rerun only
 * when it was inspected, is relevant, passes, and is bound to this candidate.
 */
export function assessReusedEvidence(
  reused: ReusedEvidence,
  candidateSha: string,
): AuditResult {
  const { evidence, inspectedWhatItTests, relevant, passing } = reused;
  if (!inspectedWhatItTests || !relevant || !passing) return "UNCERTAIN";
  if ((reused.applicabilityNote ?? "").trim().length === 0) return "UNCERTAIN";
  return assessRequirementEvidence(evidence.requirementId, [evidence], candidateSha);
}

export interface FinalCheckpointInputs {
  requirements: FinalCheckpointRequirement[];
  /** Direct evidence per requirement ID (absent key = missing report for it). */
  evidenceByRequirement: Record<string, AuditEvidence[]>;
  /** Reused QA/CI evidence per requirement ID. */
  reusedByRequirement?: Record<string, ReusedEvidence[]>;
  /** Full 40-char candidate SHA findings are assessed against. */
  candidateSha: string;
  /**
   * Post-deployment verification outcomes per requirement ID, assessed against
   * the DEPLOYED artifact. Absent = post-deployment check not yet run.
   */
  postDeploymentOutcomes?: Record<string, AuditResult>;
}

/** Runs the final checkpoint. Pure function of its inputs. */
export function assessFinalCheckpoint(inputs: FinalCheckpointInputs): FinalCheckpointResult {
  const findings: FinalCheckpointFinding[] = [];
  let hold = false;
  let deploymentOnly = false;

  for (const req of inputs.requirements) {
    if (req.lifecycle !== "active") continue;

    if (req.releasePhase === "post") {
      const outcome = inputs.postDeploymentOutcomes?.[req.id];
      if (outcome === undefined) {
        // Pre-release PASS authorizes deployment only; completion stays blocked.
        deploymentOnly = true;
        findings.push({
          requirementId: req.id,
          result: "UNCERTAIN",
          note: "post-deployment check pending for the deployed artifact; deployment authorized, completion blocked",
        });
        if (req.classification === "mandatory") hold = true;
        continue;
      }
      findings.push({ requirementId: req.id, result: outcome });
      if (req.classification === "mandatory" && outcome !== "PASS") hold = true;
      continue;
    }

    const direct = inputs.evidenceByRequirement[req.id];
    const reused = inputs.reusedByRequirement?.[req.id] ?? [];
    if ((direct === undefined || direct.length === 0) && reused.length === 0) {
      findings.push({ requirementId: req.id, result: "MISSING", note: "missing report" });
      if (req.classification === "mandatory") hold = true;
      continue;
    }

    const results: AuditResult[] = [];
    if (direct !== undefined && direct.length > 0) {
      results.push(assessRequirementEvidence(req.id, direct, inputs.candidateSha));
    }
    for (const r of reused) {
      results.push(assessReusedEvidence(r, inputs.candidateSha));
    }
    const worst = worstResult(results);
    findings.push({ requirementId: req.id, result: worst });
    // Advisory gaps are reported without blocking.
    if (req.classification === "mandatory" && worst !== "PASS") hold = true;
  }

  return { decision: hold ? "HOLD" : "PASS", deploymentOnly, findings };
}

function worstResult(results: AuditResult[]): AuditResult {
  const rank: Record<AuditResult, number> = { PASS: 0, PARTIAL: 1, UNCERTAIN: 2, MISSING: 3 };
  let worst: AuditResult = "PASS";
  for (const r of results) {
    if (rank[r] > rank[worst]) worst = r;
  }
  return worst;
}
