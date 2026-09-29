/**
 * Veera T4 — parent-delivery completion gate (JES-149, PRD section 8 integration).
 *
 * This module is the controlled parent-delivery completion path: the delivery
 * owner (Ahti-CTO) runs it — via `scripts/veera-gate.mjs --mode completion`
 * — before closing the parent delivery issue. It REJECTS incomplete, stale,
 * or moved-candidate completions; a prompt saying "refuse" is not
 * enforcement, this check is.
 *
 * Enforcement rules (PRD sections 7 + 8, plan T4):
 *  - Completion requires a full final PASS with NO partition: post-deployment
 *    requirements must now be PASS with evidence bound to the DEPLOYED
 *    artifact. Production-only pending blocks completion (HOLD) without
 *    having blocked deployment (AC-11) — prove it by pairing a release PASS
 *    (deploymentOnly) with a completion HOLD on the same fixtures.
 *  - Only the pinned candidate's deployment counts: `deployedSha` must equal
 *    the approved pinned SHA and the authoritative binding. Moving the
 *    candidate before execution blocks completion (AC-14).
 *  - Contract-only change invalidates old approval; plan change invalidates
 *    plan approval (AC-07) — enforced through the T2 validator bindings.
 *  - Intermediate work never completes the parent: `completionKind` must be
 *    `"parent"`; anything else is rejected, not passed through.
 *
 * Honest boundary (documented in `enforcement-integration.md`): this adapter
 * cannot hard-block the Paperclip issue-close API itself. Completion is
 * enforced because the controlled close procedure REQUIRES a PASS verdict
 * from this gate first; a direct API close bypassing the procedure remains a
 * named administrator bypass, not a supported path.
 *
 * Pure and deterministic: no clock, no randomness, no I/O.
 */

import {
  validateVeeraEligibility,
  type ValidatorInputs,
} from "./validator.js";
import type { ValidationFailure } from "./types.js";

const HEX40 = /^[0-9a-f]{40}$/;

export type CompletionVerdict = "PASS" | "HOLD";

export interface CompletionGateInputs extends ValidatorInputs {
  /** Delivery being completed (must match the authoritative delivery ID). */
  parentDeliveryId: string;
  /** SHA of the artifact actually deployed (must be the pinned candidate). */
  deployedSha: string;
  /** Approved pinned candidate SHA. */
  pinnedCandidateSha: string;
}

export interface CompletionBlock {
  /** PRD section 8 case number when the block comes from the validator. */
  case?: ValidationFailure["case"];
  code: string;
  message: string;
}

export interface CompletionGateResult {
  verdict: CompletionVerdict;
  blocks: CompletionBlock[];
  notes: string[];
}

/** Controlled parent-delivery completion check. Pure function of its inputs. */
export function evaluateCompletionGate(inputs: CompletionGateInputs): CompletionGateResult {
  const blocks: CompletionBlock[] = [];
  const notes: string[] = [];

  const push = (code: string, message: string, kase?: ValidationFailure["case"]): void => {
    blocks.push(kase === undefined ? { code, message } : { case: kase, code, message });
  };

  if (inputs.parentDeliveryId !== inputs.bindings.deliveryId) {
    push(
      "completion.delivery_mismatch",
      `parent delivery ${JSON.stringify(inputs.parentDeliveryId)} != authoritative ${JSON.stringify(inputs.bindings.deliveryId)}`,
    );
  }
  if (!HEX40.test(inputs.deployedSha)) {
    push("completion.deployed_sha_format", "deployed SHA is not a full 40-char hex SHA");
  }
  if (!HEX40.test(inputs.pinnedCandidateSha)) {
    push("completion.pinned_sha_format", "pinned candidate SHA is not a full 40-char hex SHA");
  }
  if (
    HEX40.test(inputs.deployedSha) &&
    HEX40.test(inputs.pinnedCandidateSha) &&
    inputs.deployedSha !== inputs.pinnedCandidateSha
  ) {
    push(
      "completion.deployed_not_pinned",
      `deployed ${inputs.deployedSha} != pinned approved ${inputs.pinnedCandidateSha}: only the pinned candidate's deployment completes the parent`,
    );
  }
  if (
    HEX40.test(inputs.pinnedCandidateSha) &&
    inputs.bindings.candidateSha !== undefined &&
    inputs.pinnedCandidateSha !== inputs.bindings.candidateSha
  ) {
    push(
      "completion.pinned_binding_mismatch",
      "pinned candidate SHA does not match the authoritative approval binding (fresh approval required)",
    );
  }

  // No partition at completion: every due mandatory requirement — including
  // post-deployment ones — must PASS with evidence bound to the deployed
  // artifact. Pending production-only checks HOLD here (AC-11).
  for (const f of validateVeeraEligibility(inputs).failures) {
    push(f.code, f.message, f.case);
  }

  if (blocks.length > 0) {
    return { verdict: "HOLD", blocks, notes };
  }
  return {
    verdict: "PASS",
    blocks: [],
    notes: [
      `parent delivery ${inputs.parentDeliveryId} completion authorized for deployed ${inputs.deployedSha}`,
    ],
  };
}
