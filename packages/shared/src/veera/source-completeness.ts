/**
 * Veera T3 — source-completeness comparison (JES-156, PRD sections 4, 6, 7).
 *
 * Direct comparison of the original PRD text + amendments against the
 * contract. Checking only the normalized requirement list is INSUFFICIENT
 * (AC-02): every normative source commitment must map to a requirement ID in
 * the contract or to an explicit justified non-requirement classification.
 * Any unmapped or weakened commitment yields HOLD, even when all listed
 * requirements pass.
 *
 * Pure and deterministic: no clock, no randomness, no I/O.
 */

import type { RequirementsContract } from "./types.js";

export type PlanFinalDecision = "PASS" | "HOLD";

/**
 * One normative commitment extracted from the source (PRD text or amendment).
 * `normative: false` entries are informational context and never block.
 */
export interface SourceCommitment {
  /** Verbatim (or minimally trimmed) normative excerpt, e.g. a "MUST" sentence. */
  excerpt: string;
  /** Source location, e.g. "PRD section 6, para 2" or amendment ref. */
  location: string;
  normative: boolean;
}

/**
 * Mapping of one source commitment to the contract: either a requirement ID
 * present in the contract, or an explicit justified non-requirement
 * classification (e.g. background context, duplicate of another commitment).
 * A mapping with neither is unmapped and yields HOLD.
 */
export interface CommitmentMapping {
  sourceExcerpt: string;
  sourceLocation: string;
  requirementId: string | null;
  /** Required when requirementId is null: why this is not a requirement. */
  nonRequirementJustification?: string;
  /** Set when the contract preserves the commitment only weakly. */
  weakened?: boolean;
  weakenNote?: string;
}

export interface SourceCompletenessResult {
  decision: PlanFinalDecision;
  /** Every unmapped/weakened/unknown-target commitment, in input order. */
  unmapped: CommitmentMapping[];
  /** Human-readable HOLD reasons, one per unmapped entry. */
  reasons: string[];
}

/**
 * Deterministic checker: returns HOLD listing every unmapped or weakened
 * commitment, even when all listed requirements pass.
 */
export function checkSourceCompleteness(
  commitments: SourceCommitment[],
  mappings: CommitmentMapping[],
  contract: RequirementsContract,
): SourceCompletenessResult {
  const contractIds = new Set(contract.requirements.map((r) => r.id));
  const unmapped: CommitmentMapping[] = [];
  const reasons: string[] = [];

  const findMapping = (c: SourceCommitment): CommitmentMapping | undefined =>
    mappings.find(
      (m) => m.sourceExcerpt === c.excerpt && m.sourceLocation === c.location,
    );

  for (const commitment of commitments) {
    if (!commitment.normative) continue;
    const mapping = findMapping(commitment);
    if (mapping === undefined) {
      const entry: CommitmentMapping = {
        sourceExcerpt: commitment.excerpt,
        sourceLocation: commitment.location,
        requirementId: null,
      };
      unmapped.push(entry);
      reasons.push(
        `unmapped normative commitment at ${commitment.location}: ${JSON.stringify(commitment.excerpt)}`,
      );
      continue;
    }
    if (mapping.requirementId === null) {
      const justification = (mapping.nonRequirementJustification ?? "").trim();
      if (justification.length === 0) {
        unmapped.push(mapping);
        reasons.push(
          `commitment at ${mapping.sourceLocation} classified as non-requirement without justification`,
        );
      }
      continue;
    }
    if (!contractIds.has(mapping.requirementId)) {
      unmapped.push(mapping);
      reasons.push(
        `commitment at ${mapping.sourceLocation} maps to unknown requirement ${JSON.stringify(mapping.requirementId)}`,
      );
      continue;
    }
    if (mapping.weakened === true) {
      unmapped.push(mapping);
      reasons.push(
        `commitment at ${mapping.sourceLocation} weakened in ${mapping.requirementId}${mapping.weakenNote ? `: ${mapping.weakenNote}` : ""}`,
      );
    }
  }

  return {
    decision: unmapped.length === 0 ? "PASS" : "HOLD",
    unmapped,
    reasons,
  };
}

/**
 * Wire the checker result into the audit `sourceCompleteness` field shape the
 * T2 validator case-5 check consumes (`accepted` only by an
 * independent-verifier role).
 */
export function toAuditSourceCompleteness(
  result: SourceCompletenessResult,
  verifierRole: string,
): { accepted: boolean; verifierRole: string; note?: string } {
  if (result.decision !== "PASS") {
    return {
      accepted: false,
      verifierRole,
      note: result.reasons.join("; "),
    };
  }
  return { accepted: true, verifierRole };
}
