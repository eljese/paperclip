/**
 * Veera T2 — validator/report acceptance tests (JES-153).
 * Covers PRD section 8 cases 1-8 plus AC-06 / AC-07 / AC-08.
 * Deterministic: pure fixtures, no clock, no I/O outside this file.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderAuditReport } from "./report.js";
import type {
  AuthoritativeBindings,
  PublisherAttestation,
  RequirementsAudit,
  RequirementsContract,
} from "./types.js";
import { sha256HexBytes, validateVeeraEligibility, type ValidatorInputs } from "./validator.js";

const HERE = dirname(fileURLToPath(import.meta.url));

const CAND_A = "a".repeat(40);
const CAND_B = "b".repeat(40);
const BASE = "c".repeat(40);
const SRC_HASH = "0".repeat(64);

const TRUSTED_PUBLISHER = "ci-protected-publisher";
const publisher: PublisherAttestation = {
  publisherId: TRUSTED_PUBLISHER,
  authenticated: true,
};

function contractDoc(extra: Partial<RequirementsContract> = {}): RequirementsContract {
  return {
    kind: "requirements-contract",
    schemaVersion: "1.0.0",
    deliveryId: "JES-000",
    sources: [{ ref: "issue JES-000 document prd revision 1", sha256: SRC_HASH }],
    scopeAuthority: {
      authority: "Ukko",
      approvalChannel: "issue thread + request_board_approval",
    },
    releaseBoundary: {
      scope: "scope",
      preReleaseBoundary: "pre",
      postDeploymentBoundary: "post",
    },
    requirements: [
      {
        id: "JES-1",
        classification: "mandatory",
        behavior: "mandatory behavior",
        acceptanceCriteria: ["criterion one"],
        sourceLocations: [{ location: "PRD s1", excerpt: "must do the thing" }],
        planRefs: ["T1"],
        verificationMethod: "inspect candidate build",
        lifecycle: "active",
      },
    ],
    ...extra,
  };
}

function evidence(candidateSha: string, requirementId = "JES-1") {
  return {
    requirementId,
    criterion: "criterion one",
    sourcePathOrArtifact: "packages/shared/src/veera/x.ts",
    method: "inspect candidate build",
    outcome: "observed",
    durableRef: "ci-artifact:run-1",
    candidateOrBuildIdentity: `github.com/eljese/paperclip @ ${candidateSha}`,
  };
}

function auditDoc(contractHash: string, extra: Partial<RequirementsAudit> = {}): RequirementsAudit {
  return {
    kind: "requirements-audit",
    schemaVersion: "1.0.0",
    deliveryId: "JES-000",
    checkpoint: "final",
    attempt: 1,
    contractRef: { deliveryId: "JES-000", contractHash },
    candidate: { repo: "github.com/eljese/paperclip", sha: CAND_A, baseSha: BASE },
    sourceCompleteness: { accepted: true, verifierRole: "veera" },
    findings: [{ requirementId: "JES-1", result: "PASS", evidence: [evidence(CAND_A)] }],
    ...extra,
  };
}

function bindings(contractHash: string, extra: Partial<AuthoritativeBindings> = {}): AuthoritativeBindings {
  return {
    deliveryId: "JES-000",
    contractHash,
    checkpoint: "final",
    repo: "github.com/eljese/paperclip",
    candidateSha: CAND_A,
    trustedPublishers: [TRUSTED_PUBLISHER],
    independentVerifierRoles: ["veera"],
    selfApprovalRoles: ["implementer", "veera"],
    amendmentApprovals: [],
    gates: {
      rehti: { verdict: "CLEAN", headSha: CAND_A },
      qa: { verdict: "PASS", headSha: CAND_A },
    },
    ...extra,
  };
}

/** Canonical valid fixture: contract bytes + matching audit + bindings. */
function validFixture(overrides: {
  contract?: Partial<RequirementsContract>;
  audit?: Partial<RequirementsAudit>;
  bindings?: Partial<AuthoritativeBindings>;
  publisher?: PublisherAttestation;
} = {}): ValidatorInputs {
  const contractBytes = JSON.stringify(contractDoc(overrides.contract));
  const hash = sha256HexBytes(contractBytes);
  const audit = auditDoc(hash, overrides.audit);
  // Keep contractRef in sync unless the test explicitly set it.
  if (overrides.audit?.contractRef === undefined) {
    audit.contractRef = { deliveryId: audit.deliveryId, contractHash: hash };
  }
  return {
    contractBytes,
    auditText: JSON.stringify(audit),
    publisher: overrides.publisher ?? publisher,
    bindings: bindings(hash, overrides.bindings),
  };
}

function casesOf(result: { failures: Array<{ case: number }> }): number[] {
  return [...new Set(result.failures.map((f) => f.case))].sort();
}

describe("veera validator", () => {
  it("accepts a fully bound eligible delivery", () => {
    const result = validateVeeraEligibility(validFixture());
    expect(result.failures).toEqual([]);
    expect(result.eligible).toBe(true);
  });

  it("is deterministic: same inputs give identical outputs", () => {
    const a = validateVeeraEligibility(validFixture());
    const b = validateVeeraEligibility(validFixture());
    expect(a).toEqual(b);
  });

  it("computes contract_hash as SHA-256 over exact bytes", () => {
    // Node reference vector: sha256("") is well-known.
    expect(sha256HexBytes("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    const bytes = JSON.stringify(contractDoc());
    expect(sha256HexBytes(bytes)).toMatch(/^[0-9a-f]{64}$/);
    // One changed byte changes the hash.
    expect(sha256HexBytes(`${bytes} `)).not.toBe(sha256HexBytes(bytes));
  });

  // ---- Case 1: bad/missing/unsupported-schema ----
  it("case 1: rejects malformed audit JSON", () => {
    const f = validFixture();
    const result = validateVeeraEligibility({ ...f, auditText: "{not json" });
    expect(result.eligible).toBe(false);
    expect(casesOf(result)).toContain(1);
  });

  it("case 1: rejects malformed contract bytes", () => {
    const f = validFixture();
    const result = validateVeeraEligibility({ ...f, contractBytes: "{not json" });
    expect(result.eligible).toBe(false);
    expect(casesOf(result)).toContain(1);
  });

  it("case 1: rejects unsupported contract schema version (AC-06 bad schema)", () => {
    const result = validateVeeraEligibility(
      validFixture({ contract: { schemaVersion: "9.9.9" } }),
    );
    expect(result.eligible).toBe(false);
    expect(result.failures.some((x) => x.code === "contract.unsupported_schema")).toBe(true);
  });

  it("case 1: rejects unsupported audit schema version", () => {
    const fx = validFixture();
    const audit = JSON.parse(fx.auditText) as RequirementsAudit;
    audit.schemaVersion = "2.0.0";
    const result = validateVeeraEligibility({ ...fx, auditText: JSON.stringify(audit) });
    expect(result.eligible).toBe(false);
    expect(result.failures.some((x) => x.code === "audit.unsupported_schema")).toBe(true);
  });

  it("case 1: rejects audit missing required fields", () => {
    const fx = validFixture();
    const audit = JSON.parse(fx.auditText) as Record<string, unknown>;
    delete audit["findings"];
    const result = validateVeeraEligibility({ ...fx, auditText: JSON.stringify(audit) });
    expect(result.eligible).toBe(false);
    expect(casesOf(result)).toContain(1);
  });

  // ---- Case 2: bindings ----
  it("case 2: rejects wrong delivery id", () => {
    const result = validateVeeraEligibility(validFixture({ bindings: { deliveryId: "JES-999" } }));
    expect(result.eligible).toBe(false);
    expect(casesOf(result)).toContain(2);
  });

  it("case 2: rejects wrong repo", () => {
    const result = validateVeeraEligibility(
      validFixture({ bindings: { repo: "github.com/other/repo" } }),
    );
    expect(result.eligible).toBe(false);
    expect(casesOf(result)).toContain(2);
  });

  it("case 2: rejects abbreviated candidate SHA", () => {
    const fx = validFixture();
    const audit = JSON.parse(fx.auditText) as RequirementsAudit;
    audit.candidate = { repo: "github.com/eljese/paperclip", sha: "abc1234" };
    const result = validateVeeraEligibility({ ...fx, auditText: JSON.stringify(audit) });
    expect(result.eligible).toBe(false);
    expect(result.failures.some((x) => x.code === "candidate.sha_format")).toBe(true);
  });

  it("case 2: rejects contract whose bytes do not match the authoritative hash", () => {
    const fx = validFixture();
    const tampered = `${fx.contractBytes} `;
    const result = validateVeeraEligibility({ ...fx, contractBytes: tampered });
    expect(result.eligible).toBe(false);
    expect(casesOf(result)).toContain(2);
  });

  it("case 2: rejects contract carrying its own hash field", () => {
    const fx = validFixture();
    const raw = JSON.parse(fx.contractBytes as string) as Record<string, unknown>;
    raw["contract_hash"] = "f".repeat(64);
    const result = validateVeeraEligibility({
      ...fx,
      contractBytes: JSON.stringify(raw),
    });
    expect(result.eligible).toBe(false);
    expect(result.failures.some((x) => x.code === "contract.self_hash")).toBe(true);
  });

  // ---- Case 3: ID set (AC-06) ----
  it("case 3: rejects omitted mandatory id (AC-06)", () => {
    const result = validateVeeraEligibility(validFixture({ audit: { findings: [] } }));
    expect(result.eligible).toBe(false);
    expect(result.failures.some((x) => x.code === "audit.omitted_mandatory")).toBe(true);
  });

  it("case 3: rejects duplicate mandatory ids in contract (AC-06)", () => {
    const c = contractDoc();
    const dup: RequirementsContract = {
      ...c,
      requirements: [...c.requirements, { ...c.requirements[0]! }],
    };
    const contractBytes = JSON.stringify(dup);
    const hash = sha256HexBytes(contractBytes);
    const result = validateVeeraEligibility({
      contractBytes,
      auditText: JSON.stringify(auditDoc(hash)),
      publisher,
      bindings: bindings(hash),
    });
    expect(result.eligible).toBe(false);
    expect(result.failures.some((x) => x.code === "contract.duplicate_id")).toBe(true);
  });

  it("case 3: rejects duplicate findings (AC-06)", () => {
    const fx = validFixture();
    const audit = JSON.parse(fx.auditText) as RequirementsAudit;
    audit.findings = [...audit.findings, ...audit.findings];
    const result = validateVeeraEligibility({ ...fx, auditText: JSON.stringify(audit) });
    expect(result.eligible).toBe(false);
    expect(result.failures.some((x) => x.code === "audit.duplicate_id")).toBe(true);
  });

  it("case 3: rejects unknown requirement ids (AC-06)", () => {
    const result = validateVeeraEligibility(
      validFixture({
        audit: {
          findings: [
            { requirementId: "JES-1", result: "PASS", evidence: [evidence(CAND_A)] },
            { requirementId: "JES-999", result: "PASS", evidence: [evidence(CAND_A, "JES-999")] },
          ],
        },
      }),
    );
    expect(result.eligible).toBe(false);
    expect(result.failures.some((x) => x.code === "audit.unknown_id")).toBe(true);
  });

  it("case 3: rejects unsupported result values", () => {
    const fx = validFixture();
    const audit = JSON.parse(fx.auditText) as Record<string, unknown>;
    (audit["findings"] as Array<Record<string, unknown>>)[0]!["result"] = "ALMOST";
    const result = validateVeeraEligibility({ ...fx, auditText: JSON.stringify(audit) });
    expect(result.eligible).toBe(false);
    expect(casesOf(result)).toContain(1); // structural enum rejection is case 1
  });

  // ---- Case 4: results + evidence (AC-06) ----
  it("case 4: rejects due mandatory != PASS", () => {
    const result = validateVeeraEligibility(
      validFixture({ audit: { findings: [{ requirementId: "JES-1", result: "PARTIAL" }] } }),
    );
    expect(result.eligible).toBe(false);
    expect(result.failures.some((x) => x.code === "finding.not_pass")).toBe(true);
  });

  it("case 4: rejects PASS missing evidence (AC-06)", () => {
    const result = validateVeeraEligibility(
      validFixture({ audit: { findings: [{ requirementId: "JES-1", result: "PASS" }] } }),
    );
    expect(result.eligible).toBe(false);
    expect(result.failures.some((x) => x.code === "finding.pass_without_evidence")).toBe(true);
  });

  it("case 4: rejects evidence not bound to the pinned candidate", () => {
    const result = validateVeeraEligibility(
      validFixture({
        audit: { findings: [{ requirementId: "JES-1", result: "PASS", evidence: [evidence(CAND_B)] }] },
      }),
    );
    expect(result.eligible).toBe(false);
    expect(result.failures.some((x) => x.code === "evidence.candidate_binding")).toBe(true);
  });

  it("case 4: rejects evidence citing the wrong requirement", () => {
    const fx = validFixture();
    const audit = JSON.parse(fx.auditText) as RequirementsAudit;
    audit.findings[0]!.evidence![0]!.requirementId = "JES-999";
    const result = validateVeeraEligibility({ ...fx, auditText: JSON.stringify(audit) });
    expect(result.eligible).toBe(false);
    expect(result.failures.some((x) => x.code === "evidence.requirement_binding")).toBe(true);
  });

  // ---- Case 5: source completeness ----
  it("case 5: rejects source completeness not accepted", () => {
    const result = validateVeeraEligibility(
      validFixture({ audit: { sourceCompleteness: { accepted: false, verifierRole: "veera" } } }),
    );
    expect(result.eligible).toBe(false);
    expect(casesOf(result)).toContain(5);
  });

  it("case 5: rejects acceptance by a non-independent role", () => {
    const result = validateVeeraEligibility(
      validFixture({ audit: { sourceCompleteness: { accepted: true, verifierRole: "implementer" } } }),
    );
    expect(result.eligible).toBe(false);
    expect(result.failures.some((x) => x.code === "source_completeness.verifier")).toBe(true);
  });

  // ---- Case 6: scope authority (AC-06, AC-08) ----
  it("case 6: rejects unauthorized empty mandatory set (AC-06)", () => {
    const result = validateVeeraEligibility(
      validFixture({ contract: { requirements: [] }, audit: { findings: [] } }),
    );
    expect(result.eligible).toBe(false);
    expect(result.failures.some((x) => x.code === "scope.unauthorized_empty_set")).toBe(true);
  });

  it("case 6: rejects self-approved removal (AC-08)", () => {
    const c = contractDoc();
    c.requirements[0]!.lifecycle = "removed";
    c.requirements[0]!.amendmentRefs = [
      {
        approvalRecordType: "issue-thread+request_board_approval",
        approvalId: "appr-1",
        issueId: "JES-000",
        approverRole: "implementer",
      },
    ];
    const contractBytes = JSON.stringify(c);
    const hash = sha256HexBytes(contractBytes);
    const result = validateVeeraEligibility({
      contractBytes,
      auditText: JSON.stringify(auditDoc(hash, { findings: [] })),
      publisher,
      bindings: bindings(hash, {
        amendmentApprovals: [
          {
            approvalRecordType: "issue-thread+request_board_approval",
            approvalId: "appr-1",
            issueId: "JES-000",
            approverRole: "implementer",
            boundContractHash: hash,
          },
        ],
      }),
    });
    expect(result.eligible).toBe(false);
    expect(result.failures.some((x) => x.code === "scope.unauthorized_change")).toBe(true);
  });

  it("case 6: rejects bare approved_by string (structural, case 1)", () => {
    const fx = validFixture();
    const raw = JSON.parse(fx.contractBytes as string) as Record<string, unknown>;
    (raw["requirements"] as Array<Record<string, unknown>>)[0]!["lifecycle"] = "superseded";
    (raw["requirements"] as Array<Record<string, unknown>>)[0]!["amendmentRefs"] = [
      { approved_by: "someone" },
    ];
    const result = validateVeeraEligibility({ ...fx, contractBytes: JSON.stringify(raw) });
    expect(result.eligible).toBe(false);
    expect(casesOf(result)).toContain(1);
  });

  it("case 6: rejects approval via the wrong channel (not issue-thread + board approval)", () => {
    const c = contractDoc();
    c.requirements[0]!.lifecycle = "superseded";
    c.requirements[0]!.amendmentRefs = [
      {
        approvalRecordType: "approved_by",
        approvalId: "appr-1",
        issueId: "JES-000",
        approverRole: "scope-authority",
      },
    ];
    const contractBytes = JSON.stringify(c);
    const hash = sha256HexBytes(contractBytes);
    const result = validateVeeraEligibility({
      contractBytes,
      auditText: JSON.stringify(auditDoc(hash, { findings: [] })),
      publisher,
      bindings: bindings(hash),
    });
    expect(result.eligible).toBe(false);
    expect(result.failures.some((x) => x.code === "scope.unauthorized_change")).toBe(true);
  });

  it("case 6: authorized amendment preserves traceability (AC-08)", () => {
    // Contract: one active mandatory (JES-1) + one removed with citation (JES-2).
    // The authoritative approval record lives in the delivery record (bindings).
    const contractBytes = JSON.stringify(
      contractDoc({
        requirements: [
          contractDoc().requirements[0]!,
          {
            id: "JES-2",
            classification: "mandatory",
            behavior: "old behavior",
            acceptanceCriteria: ["old criterion"],
            sourceLocations: [{ location: "PRD s9", excerpt: "old promise" }],
            lifecycle: "removed",
            amendmentRefs: [
              {
                approvalRecordType: "issue-thread+request_board_approval",
                approvalId: "appr-9",
                issueId: "JES-000",
                approverRole: "scope-authority",
              },
            ],
          },
        ],
      }),
    );
    const hash = sha256HexBytes(contractBytes);
    const result = validateVeeraEligibility({
      contractBytes,
      auditText: JSON.stringify(auditDoc(hash)),
      publisher,
      bindings: bindings(hash, {
        amendmentApprovals: [
          {
            approvalRecordType: "issue-thread+request_board_approval",
            approvalId: "appr-9",
            issueId: "JES-000",
            approverRole: "scope-authority",
            boundContractHash: hash,
          },
        ],
      }),
    });
    expect(result.failures).toEqual([]);
    expect(result.eligible).toBe(true);
  });

  it("case 6: rejects removal citing an approval missing from the delivery record", () => {
    const c = contractDoc();
    c.requirements[0]!.lifecycle = "superseded";
    c.requirements[0]!.amendmentRefs = [
      {
        approvalRecordType: "issue-thread+request_board_approval",
        approvalId: "appr-ghost",
        issueId: "JES-000",
        approverRole: "scope-authority",
      },
    ];
    const contractBytes = JSON.stringify(c);
    const hash = sha256HexBytes(contractBytes);
    const result = validateVeeraEligibility({
      contractBytes,
      auditText: JSON.stringify(auditDoc(hash, { findings: [] })),
      publisher,
      bindings: bindings(hash),
    });
    expect(result.eligible).toBe(false);
    expect(result.failures.some((x) => x.code === "scope.unauthorized_change")).toBe(true);
  });

  // ---- Case 7: publisher (fail closed) ----
  it("case 7: fails closed with empty trusted-publisher allowlist", () => {
    const result = validateVeeraEligibility(validFixture({ bindings: { trustedPublishers: [] } }));
    expect(result.eligible).toBe(false);
    expect(result.failures.some((x) => x.code === "publisher.untrusted")).toBe(true);
  });

  it("case 7: rejects unauthenticated publisher", () => {
    const result = validateVeeraEligibility(
      validFixture({ publisher: { publisherId: TRUSTED_PUBLISHER, authenticated: false } }),
    );
    expect(result.eligible).toBe(false);
    expect(result.failures.some((x) => x.code === "publisher.unauthenticated")).toBe(true);
  });

  it("case 7: rejects agent_name field in audit", () => {
    const fx = validFixture();
    const audit = JSON.parse(fx.auditText) as Record<string, unknown>;
    audit["agent_name"] = "veera";
    const result = validateVeeraEligibility({ ...fx, auditText: JSON.stringify(audit) });
    expect(result.eligible).toBe(false);
    expect(result.failures.some((x) => x.code === "audit.agent_name")).toBe(true);
  });

  it("case 7: rejects implementer-uploaded audit even with valid content", () => {
    const result = validateVeeraEligibility(
      validFixture({ publisher: { publisherId: "implementer-uploader", authenticated: true } }),
    );
    expect(result.eligible).toBe(false);
    expect(result.failures.some((x) => x.code === "publisher.untrusted")).toBe(true);
  });

  // ---- Case 8: gates ----
  it("case 8: rejects missing Rehti gate", () => {
    const fx = validFixture();
    const gates = { ...fx.bindings.gates, rehti: undefined };
    const result = validateVeeraEligibility({
      ...fx,
      bindings: { ...fx.bindings, gates },
    });
    expect(result.eligible).toBe(false);
    expect(result.failures.some((x) => x.code === "gates.rehti_missing")).toBe(true);
  });

  it("case 8: rejects missing QA gate", () => {
    const fx = validFixture();
    const gates = { ...fx.bindings.gates, qa: undefined };
    const result = validateVeeraEligibility({
      ...fx,
      bindings: { ...fx.bindings, gates },
    });
    expect(result.eligible).toBe(false);
    expect(result.failures.some((x) => x.code === "gates.qa_missing")).toBe(true);
  });

  it("case 8: changed HEAD invalidates gates", () => {
    const fx = validFixture();
    const result = validateVeeraEligibility({
      ...fx,
      bindings: {
        ...fx.bindings,
        gates: {
          rehti: { verdict: "CLEAN", headSha: CAND_B },
          qa: { verdict: "PASS", headSha: CAND_A },
        },
      },
    });
    expect(result.eligible).toBe(false);
    expect(result.failures.some((x) => x.code === "gates.rehti_stale")).toBe(true);
  });

  // ---- AC-07: approval invalidation ----
  it("AC-07: approval for SHA-A cannot release SHA-B", () => {
    const fx = validFixture();
    const audit = JSON.parse(fx.auditText) as RequirementsAudit;
    audit.candidate = { repo: "github.com/eljese/paperclip", sha: CAND_B, baseSha: BASE };
    const ev = evidence(CAND_B);
    audit.findings = [{ requirementId: "JES-1", result: "PASS", evidence: [ev] }];
    const result = validateVeeraEligibility({ ...fx, auditText: JSON.stringify(audit) });
    expect(result.eligible).toBe(false);
    expect(result.failures.some((x) => x.code === "candidate.sha_mismatch")).toBe(true);
  });

  it("AC-07: contract-only change invalidates old approval", () => {
    const fx = validFixture();
    // Same audit (binds old hash) but authoritative contract changed.
    const changed = JSON.parse(fx.contractBytes as string) as RequirementsContract;
    changed.releaseBoundary.scope = "changed scope";
    const newBytes = JSON.stringify(changed);
    const newHash = sha256HexBytes(newBytes);
    const result = validateVeeraEligibility({
      ...fx,
      contractBytes: newBytes,
      bindings: { ...fx.bindings, contractHash: newHash },
    });
    expect(result.eligible).toBe(false);
    expect(casesOf(result)).toContain(2);
  });

  it("AC-07: plan change invalidates old plan approval", () => {
    const contractBytes = JSON.stringify(contractDoc());
    const hash = sha256HexBytes(contractBytes);
    const planAudit: RequirementsAudit = {
      kind: "requirements-audit",
      schemaVersion: "1.0.0",
      deliveryId: "JES-000",
      checkpoint: "plan",
      planRef: { planRevision: "rev-1", planHash: "1".repeat(64) },
      contractRef: { deliveryId: "JES-000", contractHash: hash },
      sourceCompleteness: { accepted: true, verifierRole: "veera" },
      findings: [{ requirementId: "JES-1", result: "PASS", evidence: [evidence(CAND_A)] }],
    };
    const result = validateVeeraEligibility({
      contractBytes,
      auditText: JSON.stringify(planAudit),
      publisher,
      bindings: bindings(hash, {
        checkpoint: "plan",
        planRevision: "rev-2",
        planHash: "2".repeat(64),
      }),
    });
    expect(result.eligible).toBe(false);
    expect(casesOf(result)).toContain(2);
  });

  it("plan checkpoint: valid plan audit is eligible", () => {
    const contractBytes = JSON.stringify(contractDoc());
    const hash = sha256HexBytes(contractBytes);
    const planAudit: RequirementsAudit = {
      kind: "requirements-audit",
      schemaVersion: "1.0.0",
      deliveryId: "JES-000",
      checkpoint: "plan",
      planRef: { planRevision: "rev-1", planHash: "1".repeat(64) },
      contractRef: { deliveryId: "JES-000", contractHash: hash },
      sourceCompleteness: { accepted: true, verifierRole: "veera" },
      findings: [{ requirementId: "JES-1", result: "PASS", evidence: [evidence(CAND_A)] }],
    };
    const result = validateVeeraEligibility({
      contractBytes,
      auditText: JSON.stringify(planAudit),
      publisher,
      bindings: bindings(hash, {
        checkpoint: "plan",
        planRevision: "rev-1",
        planHash: "1".repeat(64),
      }),
    });
    expect(result.failures).toEqual([]);
    expect(result.eligible).toBe(true);
  });
});

describe("veera report", () => {
  it("renders from audit JSON only, with HOLD verdict and next actions", () => {
    const contractBytes = JSON.stringify(
      contractDoc({
        requirements: [
          ...contractDoc().requirements,
          {
            id: "JES-2",
            classification: "mandatory",
            behavior: "second behavior",
            acceptanceCriteria: ["criterion two"],
            sourceLocations: [{ location: "PRD s2", excerpt: "must do more" }],
            planRefs: ["T2"],
            verificationMethod: "inspect",
            lifecycle: "active",
          },
        ],
      }),
    );
    const hash = sha256HexBytes(contractBytes);
    const audit = auditDoc(hash, {
      findings: [
        { requirementId: "JES-1", result: "PASS", evidence: [evidence(CAND_A)] },
        { requirementId: "JES-2", result: "MISSING", note: "not implemented" },
      ],
    });
    const result = validateVeeraEligibility({
      contractBytes,
      auditText: JSON.stringify(audit),
      publisher,
      bindings: bindings(hash),
    });
    expect(result.eligible).toBe(false);
    const md = renderAuditReport({ audit, result });
    expect(md).toContain("**HOLD**");
    expect(md).toContain("JES-2");
    expect(md).toContain("engineer correction");
    expect(md).not.toContain("**ELIGIBLE**");
  });

  it("renders ELIGIBLE for a passing audit", () => {
    const fx = validFixture();
    const audit = JSON.parse(fx.auditText) as RequirementsAudit;
    const result = validateVeeraEligibility(fx);
    const md = renderAuditReport({ audit, result });
    expect(md).toContain("**ELIGIBLE**");
    expect(md).toContain(CAND_A);
  });

  it("minimal examples are structurally valid and the valid example is eligible", () => {
    const contractText = readFileSync(
      join(HERE, "examples", "requirements-contract.example.json"),
      "utf-8",
    );
    const auditText = readFileSync(
      join(HERE, "examples", "requirements-audit.example.json"),
      "utf-8",
    );
    const contract = JSON.parse(contractText) as RequirementsContract;
    expect(contract.kind).toBe("requirements-contract");
    const hash = sha256HexBytes(contractText);
    const audit = JSON.parse(
      (auditText as string).replace("RECOMPUTED_AT_RUNTIME_OVER_EXACT_CONTRACT_BYTES", hash),
    ) as RequirementsAudit;
    const exampleSha = "062c8d7237a9d3e1671c2b071da73bae6fc23d63";
    const result = validateVeeraEligibility({
      contractBytes: contractText,
      auditText: JSON.stringify(audit),
      publisher,
      bindings: bindings(hash, {
        deliveryId: contract.deliveryId,
        candidateSha: exampleSha,
        gates: {
          rehti: { verdict: "CLEAN", headSha: exampleSha },
          qa: { verdict: "PASS", headSha: exampleSha },
        },
      }),
    });
    // Example contract deliveryId is JES-000, matching default bindings.
    expect(result.failures).toEqual([]);
    expect(result.eligible).toBe(true);
  });
});
