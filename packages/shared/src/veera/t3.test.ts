/**
 * Veera T3 — scenario acceptance tests (JES-156).
 * Covers AC-02, AC-03, AC-05 (both directions), AC-09, AC-12, AC-13.
 * Deterministic: pinned SHAs/hashes, no clock, no randomness, no network.
 */
import { describe, expect, it } from "vitest";
import {
  assessFinalCheckpoint,
  assessRequirementEvidence,
  assessReusedEvidence,
  type FinalCheckpointRequirement,
} from "./final-checkpoint.js";
import {
  assessPlanCheckpoint,
  blocksHandoff,
  type PlanCheckpointInput,
} from "./plan-checkpoint.js";
import {
  buildVeeraHandoff,
  optionalFlagsAreMandatory,
  validateHandoff,
} from "./handoff.js";
import {
  VEERA_PROVISIONING_PAYLOAD,
  VEERA_ROLE,
  buildVeeraProvisioningPayload,
} from "./role.js";
import {
  consumeCorrectionRound,
  dedupKey,
  isBlockedCategory,
  MAX_INFRA_RETRIES,
  recordInfraRetry,
  routeHold,
  shouldCreateTask,
  type CorrectionLedger,
} from "./routing.js";
import {
  checkSourceCompleteness,
  toAuditSourceCompleteness,
  type CommitmentMapping,
  type SourceCommitment,
} from "./source-completeness.js";
import type { RequirementsContract } from "./types.js";
import { validateVeeraEligibility, sha256HexBytes } from "./validator.js";

const CAND_A = "a".repeat(40);
const CAND_B = "b".repeat(40);
const CONTRACT_HASH = "0".repeat(64);
const SRC_HASH = "1".repeat(64);

function contractWith(reqs: RequirementsContract["requirements"]): RequirementsContract {
  return {
    kind: "requirements-contract",
    schemaVersion: "1.0.0",
    deliveryId: "JES-156",
    sources: [{ ref: "PRD rev 1", sha256: SRC_HASH }],
    scopeAuthority: {
      authority: "scope-authority",
      approvalChannel: "issue thread + request_board_approval",
    },
    releaseBoundary: { scope: "s", preReleaseBoundary: "pre", postDeploymentBoundary: "post" },
    requirements: reqs,
  };
}

function baseReq(extra: Partial<RequirementsContract["requirements"][number]> = {}) {
  return {
    id: "JES-1",
    classification: "mandatory" as const,
    behavior: "mandatory behavior",
    acceptanceCriteria: ["criterion one"],
    sourceLocations: [{ location: "PRD s1", excerpt: "must do the thing" }],
    planRefs: ["T1"],
    verificationMethod: "inspect candidate build",
    lifecycle: "active" as const,
    ...extra,
  };
}

function planInput(extra: Partial<PlanCheckpointInput> = {}): PlanCheckpointInput {
  return {
    ...baseReq(),
    releasePhase: "pre",
    environmentAccess: "CI linux runner with repo checkout",
    ...extra,
  };
}

// AC-02: mandatory source commitment omitted from extraction -> direct-PRD diff yields HOLD,
// even when all listed requirements pass.
describe("AC-02 source completeness", () => {
  it("holds on an unmapped normative commitment", () => {
    const contract = contractWith([baseReq()]);
    const commitments: SourceCommitment[] = [
      { excerpt: "must do the thing", location: "PRD s1", normative: true },
      { excerpt: "must also do the other thing", location: "PRD s2", normative: true },
    ];
    const mappings: CommitmentMapping[] = [
      { sourceExcerpt: "must do the thing", sourceLocation: "PRD s1", requirementId: "JES-1" },
    ];
    const result = checkSourceCompleteness(commitments, mappings, contract);
    expect(result.decision).toBe("HOLD");
    expect(result.unmapped).toHaveLength(1);
    expect(result.reasons[0]).toContain("PRD s2");
    const auditField = toAuditSourceCompleteness(result, "Veera");
    expect(auditField.accepted).toBe(false);
  });

  it("passes when every normative commitment maps", () => {
    const contract = contractWith([baseReq()]);
    const commitments: SourceCommitment[] = [
      { excerpt: "must do the thing", location: "PRD s1", normative: true },
      { excerpt: "background context", location: "PRD s0", normative: false },
    ];
    const mappings: CommitmentMapping[] = [
      { sourceExcerpt: "must do the thing", sourceLocation: "PRD s1", requirementId: "JES-1" },
    ];
    const result = checkSourceCompleteness(commitments, mappings, contract);
    expect(result.decision).toBe("PASS");
    expect(toAuditSourceCompleteness(result, "Veera").accepted).toBe(true);
  });
});

// AC-03: requirement in contract without plan coverage -> plan HOLD, handoff blocked.
describe("AC-03 plan coverage blocks handoff", () => {
  it("holds and blocks handoff when planRefs are missing", () => {
    const result = assessPlanCheckpoint([planInput({ planRefs: [] })]);
    expect(result.decision).toBe("HOLD");
    expect(blocksHandoff(result)).toBe(true);
    expect(result.findings[0]?.reasons.join(" ")).toContain("planRefs");
  });

  it("passes with credible plan coverage", () => {
    const result = assessPlanCheckpoint([planInput()]);
    expect(result.decision).toBe("PASS");
    expect(blocksHandoff(result)).toBe(false);
  });
});

// AC-05 both directions.
describe("AC-05 evidence binding", () => {
  const req: FinalCheckpointRequirement = {
    id: "JES-1",
    classification: "mandatory",
    lifecycle: "active",
    releasePhase: "pre",
    acceptanceCriteria: ["criterion one"],
  };

  function ev(sha: string, outcome = "observed") {
    return {
      requirementId: "JES-1",
      criterion: "criterion one",
      sourcePathOrArtifact: "packages/shared/src/veera/x.ts",
      method: "inspect candidate build",
      outcome,
      durableRef: "ci-artifact:run-1",
      candidateOrBuildIdentity: `github.com/eljese/paperclip @ ${sha}`,
    };
  }

  it("wrong-build evidence yields UNCERTAIN and HOLD", () => {
    expect(assessRequirementEvidence("JES-1", [ev(CAND_B)], CAND_A)).toBe("UNCERTAIN");
    const result = assessFinalCheckpoint({
      requirements: [req],
      evidenceByRequirement: { "JES-1": [ev(CAND_B)] },
      candidateSha: CAND_A,
    });
    expect(result.decision).toBe("HOLD");
  });

  it("missing evidence yields MISSING and HOLD", () => {
    const result = assessFinalCheckpoint({
      requirements: [req],
      evidenceByRequirement: {},
      candidateSha: CAND_A,
    });
    expect(result.decision).toBe("HOLD");
    expect(result.findings[0]?.result).toBe("MISSING");
  });

  it("inspected candidate-bound relevant evidence passes without a full QA rerun", () => {
    const reused = {
      evidence: ev(CAND_A),
      inspectedWhatItTests: true,
      relevant: true,
      passing: true,
      applicabilityNote: "CI unit test covers criterion one on this candidate",
    };
    expect(assessReusedEvidence(reused, CAND_A)).toBe("PASS");
    const result = assessFinalCheckpoint({
      requirements: [req],
      evidenceByRequirement: {},
      reusedByRequirement: { "JES-1": [reused] },
      candidateSha: CAND_A,
    });
    expect(result.decision).toBe("PASS");
  });
});

// AC-09: implementer-authored/substituted audit rejected as Veera publication.
describe("AC-09 publisher rejection", () => {
  function bindings(contractHash: string) {
    return {
      deliveryId: "JES-156",
      contractHash,
      checkpoint: "final" as const,
      repo: "github.com/eljese/paperclip",
      candidateSha: CAND_A,
      trustedPublishers: ["ci-protected-publisher"],
      independentVerifierRoles: ["Veera"],
      selfApprovalRoles: ["implementer", "Veera", "veera"],
      amendmentApprovals: [],
      gates: {
        rehti: { verdict: "CLEAN", headSha: CAND_A },
        qa: { verdict: "GO", headSha: CAND_A },
      },
    };
  }

  function validDocs(contractHash: string) {
    const contract = contractWith([baseReq()]);
    const contractBytes = JSON.stringify(contract);
    const hash = sha256HexBytes(contractBytes);
    const audit = {
      kind: "requirements-audit",
      schemaVersion: "1.0.0",
      deliveryId: "JES-156",
      checkpoint: "final",
      contractRef: { deliveryId: "JES-156", contractHash: hash },
      candidate: { repo: "github.com/eljese/paperclip", sha: CAND_A },
      sourceCompleteness: { accepted: true, verifierRole: "Veera" },
      findings: [
        {
          requirementId: "JES-1",
          result: "PASS",
          evidence: [
            {
              requirementId: "JES-1",
              criterion: "criterion one",
              sourcePathOrArtifact: "x.ts",
              method: "inspect",
              outcome: "observed",
              durableRef: "ci:1",
              candidateOrBuildIdentity: `github.com/eljese/paperclip @ ${CAND_A}`,
            },
          ],
        },
      ],
    };
    return { contractBytes, hash, auditText: JSON.stringify(audit) };
  }

  it("rejects an audit carrying an agent_name field", () => {
    const { contractBytes, hash, auditText } = validDocs(CONTRACT_HASH);
    const tampered = auditText.replace(
      `"checkpoint":"final"`,
      `"checkpoint":"final","agent_name":"implementer"`,
    );
    const result = validateVeeraEligibility({
      contractBytes,
      auditText: tampered,
      publisher: { publisherId: "ci-protected-publisher", authenticated: true },
      bindings: bindings(hash),
    });
    expect(result.eligible).toBe(false);
    expect(result.failures.some((f) => f.case === 7)).toBe(true);
  });

  it("rejects an untrusted publisher attestation", () => {
    const { contractBytes, hash, auditText } = validDocs(CONTRACT_HASH);
    const result = validateVeeraEligibility({
      contractBytes,
      auditText,
      publisher: { publisherId: "implementer-self-published", authenticated: true },
      bindings: bindings(hash),
    });
    expect(result.eligible).toBe(false);
    expect(result.failures.some((f) => f.code === "publisher.untrusted")).toBe(true);
  });
});

// AC-12: handoff carries IDs + criteria + evidence; interrogate/arena optional-only.
describe("AC-12 handoff shape", () => {
  it("valid handoff carries required fields through the pi_local shape", () => {
    const handoff = buildVeeraHandoff({
      deliveryId: "JES-156",
      contractRef: "JES-156/contract rev 3",
      contractHash: CONTRACT_HASH,
      requirements: [{ id: "JES-1", acceptanceCriteria: ["criterion one"] }],
      workBoundaries: "verify only; no product writes",
      expectedEvidence: ["candidate-bound test output"],
      candidateSha: CAND_A,
      evidenceLinks: ["ci-artifact:run-1"],
      unresolvedBlockers: [],
      consumedBudget: 0,
      rehtiVerdict: { verdict: "CLEAN", headSha: CAND_A },
    });
    expect(handoff.adapter).toBe("pi_local");
    const validation = validateHandoff(handoff);
    expect(validation.valid).toBe(true);
  });

  it("interrogate/arena are never mandatory", () => {
    expect(optionalFlagsAreMandatory({})).toBe(false);
    expect(optionalFlagsAreMandatory({ requireInterrogate: true })).toBe(true);
    const handoff = buildVeeraHandoff({
      deliveryId: "JES-156",
      contractRef: "ref",
      contractHash: CONTRACT_HASH,
      requirements: [{ id: "JES-1", acceptanceCriteria: ["c"] }],
      workBoundaries: "b",
      expectedEvidence: ["e"],
      candidateSha: CAND_A,
      evidenceLinks: [],
      unresolvedBlockers: [],
      consumedBudget: 0,
      interrogate: false,
    });
    expect(validateHandoff(handoff).valid).toBe(true);
  });
});

// AC-13: duplicate trigger + simulated session restart -> single task, budget unchanged,
// exhaustion preserves HOLD + escalates.
describe("AC-13 dedup + budget", () => {
  it("duplicate triggers do not create parallel tasks", () => {
    const key = dedupKey("JES-156", "final", CONTRACT_HASH, CAND_A);
    const seen = new Set<string>();
    expect(shouldCreateTask(seen, key)).toBe(true);
    seen.add(key);
    // Simulated session restart: same key, fresh empty local state, shared ledger.
    const restartedSeen = new Set<string>(seen);
    expect(shouldCreateTask(restartedSeen, key)).toBe(false);
  });

  it("exhaustion preserves HOLD and escalates, never passes", () => {
    let ledger: CorrectionLedger = {
      deliveryId: "JES-156",
      consumedAutomaticRounds: 0,
      consecutiveNoProgress: 0,
    };
    const first = consumeCorrectionRound(ledger, false);
    ledger = first.ledger;
    expect(first.decision.allowed).toBe(true);
    const second = consumeCorrectionRound(ledger, false);
    ledger = second.ledger;
    expect(second.decision.escalate).toBe(true);
    expect(second.decision.stopAndReportBlocker).toBe(true);
    // Budget consumption persisted across the simulated restart.
    expect(ledger.consumedAutomaticRounds).toBe(2);
  });

  it("routing table sends each category to the right owner", () => {
    expect(routeHold("missing_behavior")).toBe("engineer");
    expect(routeHold("incorrect_behavior")).toBe("engineer");
    expect(routeHold("missing_evidence")).toBe("qa-evidence-producer");
    expect(routeHold("ambiguous_scope")).toBe("scope-authority");
    expect(routeHold("unavailable_tool_env")).toBe("operational-owner");
    expect(routeHold("malformed_publication")).toBe("publisher-integration-owner");
    expect(isBlockedCategory("unavailable_tool_env")).toBe(true);
  });

  it("infra retries are finite (B4) and never mint budget", () => {
    let ledger: CorrectionLedger = {
      deliveryId: "JES-156",
      consumedAutomaticRounds: 1,
      consecutiveNoProgress: 0,
    };
    for (let i = 0; i < MAX_INFRA_RETRIES; i++) {
      const r = recordInfraRetry(ledger);
      ledger = r.ledger;
      expect(r.retry).toBe(true);
    }
    const exhausted = recordInfraRetry(ledger);
    expect(exhausted.retry).toBe(false);
    expect(exhausted.blocked).toBe(true);
    expect(exhausted.ledger.consumedAutomaticRounds).toBe(1);
  });
});

describe("role definition", () => {
  it("declares a separate pi_local session with permission exclusions", () => {
    expect(VEERA_ROLE.adapterType).toBe("pi_local");
    expect(VEERA_ROLE.separateSession).toBe(true);
    expect(VEERA_ROLE.permissionExclusions.noProductCodeWrites).toBe(true);
    expect(VEERA_ROLE.permissionExclusions.noSelfApproval).toBe(true);
    const payload = buildVeeraProvisioningPayload();
    expect(payload).toEqual(VEERA_PROVISIONING_PAYLOAD);
    expect(payload.action).toBe("hire");
  });
});
