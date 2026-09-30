/**
 * Veera T4 — release-path enforcement gate (JES-149, PRD section 8 integration).
 *
 * This module is the REAL pre-deployment entry point: `scripts/release.sh`
 * invokes it (via `scripts/veera-gate.mjs`) before publishing, and its tests
 * exercise this gate — not just the T2 validator underneath.
 *
 * Enforcement rules (PRD section 8 + plan T4):
 *  - Final-checkpoint rule (JES-176 F-01a): `bindings.checkpoint` AND the
 *    audit checkpoint must both be `"final"`. A plan-only audit (even a
 *    clean one) HOLDs release — plan approval never authorizes deployment.
 *  - Pinned-SHA re-check: the SHA observed immediately before release
 *    (`actualHeadSha`, resolved from git at gate time) must equal the approved
 *    pinned candidate SHA AND the authoritative `bindings.candidateSha`.
 *    A moved branch (squash/merge/rebase produced a new SHA) blocks release;
 *    only the pinned candidate releases (AC-14).
 *  - Deploy the pinned approved artifact: `deployArtifactSha` (default:
 *    `actualHeadSha`) must equal the pinned SHA.
 *  - Multi-PR rule (AC-11): `releaseKind: "intermediate"` (this release does
 *    NOT carry the delivery's committed scope) returns NOT_APPLICABLE —
 *    existing technical gates apply, and this verdict is NEVER a Veera
 *    approval. `releaseKind: "scoped"` requires full eligibility.
 *  - Production-only requirements (AC-11): requirement IDs declared (in the
 *    authoritative delivery record) as post-deployment may be pending
 *    (UNCERTAIN) at release time without blocking DEPLOYMENT; the verdict
 *    carries `deploymentOnly: true` and parent completion stays blocked until
 *    they pass (see `completion-gate.ts`). Every other validator failure
 *    blocks release, including omitted mandatory IDs and non-pending HOLDs.
 *  - Contract-only change invalidates old approval; plan change invalidates
 *    plan approval (AC-07) — enforced through the T2 validator bindings and
 *    re-tested here through this entry point.
 *
 * Pure and deterministic: no clock, no randomness, no I/O. The caller
 * supplies the authoritatively observed SHA (the CLI resolves it from git).
 */

import {
  validateVeeraEligibility,
  type ValidatorInputs,
} from "./validator.js";
import type {
  AuthoritativeBindings,
  PublisherAttestation,
  ValidationFailure,
} from "./types.js";

const HEX40 = /^[0-9a-f]{40}$/;

/** Whether this release carries the delivery's committed scope. */
export type ReleaseKind = "scoped" | "intermediate";

export type ReleaseVerdict = "PASS" | "HOLD" | "NOT_APPLICABLE";

export interface ReleaseGateInputs extends ValidatorInputs {
  /** SHA observed immediately before release (fresh `git rev-parse HEAD`). */
  actualHeadSha: string;
  /** Approved pinned candidate SHA this release is allowed to ship. */
  pinnedCandidateSha: string;
  /**
   * Artifact about to be deployed (npm payload source, container digest
   * source, ...). Defaults to `actualHeadSha`.
   */
  deployArtifactSha?: string;
  /** Repo identity of the checkout being released. */
  releaseRepo?: string;
  /** Scoped = committed scope; intermediate = existing gates apply. */
  releaseKind: ReleaseKind;
  /**
   * Mandatory requirement IDs declared post-deployment in the authoritative
   * delivery record. Pending (UNCERTAIN) findings for exactly these IDs do
   * not block deployment; they block completion instead.
   */
  postDeploymentRequirementIds?: string[];
}

export interface GateBlock {
  /** PRD section 8 case number when the block comes from the validator. */
  case?: ValidationFailure["case"];
  code: string;
  message: string;
}

export interface ReleaseGateResult {
  verdict: ReleaseVerdict;
  /** True when pre-release PASS authorizes deployment ONLY (AC-11). */
  deploymentOnly: boolean;
  /** The exact SHA this verdict applies to (never transfers across SHAs). */
  gatedSha: string | null;
  blocks: GateBlock[];
  notes: string[];
}

function block(
  blocks: GateBlock[],
  code: string,
  message: string,
  kase?: ValidationFailure["case"],
): void {
  blocks.push(kase === undefined ? { code, message } : { case: kase, code, message });
}

function failureRequirementId(f: ValidationFailure): string | null {
  const m = /"([A-Z0-9]+-[0-9]+)"/.exec(f.message);
  return m ? (m[1] as string) : null;
}

/**
 * A validator failure is deployment-deferrable only when it is a case-4
 * pending finding (UNCERTAIN result, or PASS-shaped evidence still missing
 * for a not-yet-run post-deployment check) for a declared post-deployment
 * requirement. Omitted IDs (case 3), stale bindings, publisher, source and
 * gate failures always block release.
 */
function isDeployDeferrablePostPending(
  f: ValidationFailure,
  postIds: ReadonlySet<string>,
): boolean {
  if (f.case !== 4) return false;
  if (f.code !== "finding.not_pass" && f.code !== "finding.pass_without_evidence") {
    return false;
  }
  const id = failureRequirementId(f);
  if (id === null || !postIds.has(id)) return false;
  if (f.code === "finding.not_pass" && !/\bUNCERTAIN\b/.test(f.message)) return false;
  return true;
}

/** Real pre-deployment release gate. Pure function of its inputs. */
export function evaluateReleaseGate(inputs: ReleaseGateInputs): ReleaseGateResult {
  const notes: string[] = [];
  const blocks: GateBlock[] = [];
  const deploySha = inputs.deployArtifactSha ?? inputs.actualHeadSha;

  // Multi-PR rule: intermediates progress under existing gates. This verdict
  // is explicitly NOT a Veera approval and never unblocks scoped release or
  // parent completion.
  if (inputs.releaseKind === "intermediate") {
    return {
      verdict: "NOT_APPLICABLE",
      deploymentOnly: false,
      gatedSha: null,
      blocks: [],
      notes: [
        "intermediate release: existing technical gates apply; Veera full acceptance still blocks parent close and scoped release",
      ],
    };
  }

  // Final-checkpoint rule (JES-176 F-01a): plan approval never authorizes
  // release. The validator only binds candidate SHA/evidence at the final
  // checkpoint, so a clean plan audit would otherwise PASS here. Both the
  // authoritative bindings and the audit itself must be final.
  if (inputs.bindings.checkpoint !== "final") {
    block(
      blocks,
      "release.checkpoint_not_final",
      `release requires final approval: authoritative checkpoint is ${JSON.stringify(inputs.bindings.checkpoint)} (plan approval never authorizes deployment)`,
    );
  }
  try {
    const auditCheckpoint = (JSON.parse(inputs.auditText) as { checkpoint?: unknown }).checkpoint;
    if (auditCheckpoint !== "final") {
      block(
        blocks,
        "release.audit_checkpoint_not_final",
        `release requires a final audit: audit checkpoint is ${JSON.stringify(auditCheckpoint)}`,
      );
    }
  } catch {
    // Unparseable audit text is already a validator case-2 failure; the
    // eligibility run below records it. No extra block here.
  }

  // Pinned-SHA re-check (AC-14): format first, then equality. Every mismatch
  // blocks — squash/merge/rebase yields a new SHA needing fresh approval.
  if (!HEX40.test(inputs.actualHeadSha)) {
    block(blocks, "release.actual_sha_format", "observed HEAD is not a full 40-char hex SHA");
  }
  if (!HEX40.test(inputs.pinnedCandidateSha)) {
    block(blocks, "release.pinned_sha_format", "pinned candidate SHA is not a full 40-char hex SHA");
  }
  if (
    HEX40.test(inputs.actualHeadSha) &&
    HEX40.test(inputs.pinnedCandidateSha) &&
    inputs.actualHeadSha !== inputs.pinnedCandidateSha
  ) {
    block(
      blocks,
      "release.candidate_moved",
      `candidate moved before release: observed ${inputs.actualHeadSha} != pinned ${inputs.pinnedCandidateSha} (fresh approval required)`,
    );
  }
  if (
    HEX40.test(inputs.pinnedCandidateSha) &&
    inputs.bindings.candidateSha !== undefined &&
    inputs.pinnedCandidateSha !== inputs.bindings.candidateSha
  ) {
    block(
      blocks,
      "release.pinned_binding_mismatch",
      "pinned candidate SHA does not match the authoritative approval binding (fresh approval required)",
    );
  }
  if (deploySha !== inputs.pinnedCandidateSha) {
    block(
      blocks,
      "release.deploy_not_pinned",
      "only the pinned approved artifact may deploy: deploy artifact differs from the pinned candidate SHA",
    );
  }
  if (
    inputs.releaseRepo !== undefined &&
    inputs.bindings.repo !== undefined &&
    inputs.releaseRepo !== inputs.bindings.repo
  ) {
    block(
      blocks,
      "release.repo_mismatch",
      `release repo ${JSON.stringify(inputs.releaseRepo)} != authoritative ${JSON.stringify(inputs.bindings.repo)}`,
    );
  }

  // Full eligibility through the T2 validator (AC-07 contract/plan drift,
  // cases 1-8). Post-deployment pendings are partitioned out for the release
  // verdict; they still block completion.
  const eligibility = validateVeeraEligibility(inputs);
  const postIds = new Set(inputs.postDeploymentRequirementIds ?? []);
  let deploymentOnly = false;
  for (const f of eligibility.failures) {
    if (postIds.size > 0 && isDeployDeferrablePostPending(f, postIds)) {
      deploymentOnly = true;
      notes.push(`post-deployment requirement pending at release: ${f.message}`);
      continue;
    }
    block(blocks, f.code, f.message, f.case);
  }

  if (blocks.length > 0) {
    return { verdict: "HOLD", deploymentOnly: false, gatedSha: null, blocks, notes };
  }
  return {
    verdict: "PASS",
    deploymentOnly,
    gatedSha: inputs.pinnedCandidateSha,
    blocks: [],
    notes,
  };
}
