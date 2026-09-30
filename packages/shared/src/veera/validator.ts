/**
 * Veera T2 — deterministic eligibility validator (JES-153, PRD section 8).
 *
 * Pure function: no clock, no randomness, no I/O. Only dependency is
 * node:crypto SHA-256 (no new crypto infra). The caller supplies the
 * AUTHORITATIVE contract bytes (delivery record) — the validator never reads
 * a candidate-chosen path.
 *
 * B2 artifact-retention note (AC-15 durability): snapshots + decisive evidence
 * survive session end because the authoritative delivery record lives in the
 * Paperclip issue thread (DB-backed, backed up) and audit outputs live in
 * Paperclip's durable object store (S3/file storage, see server/src/config.ts
 * storageS3* settings) plus immutable CI/task artifacts — all OUTSIDE the
 * candidate commit and outside any agent session-local workspace.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  SUPPORTED_AUDIT_SCHEMA_VERSIONS,
  SUPPORTED_CONTRACT_SCHEMA_VERSIONS,
  type AmendmentRef,
  type AuditFinding,
  type AuthoritativeBindings,
  type GateInputs,
  type PublisherAttestation,
  type RequirementsAudit,
  type RequirementsContract,
  type ValidationFailure,
  type ValidationResult,
} from "./types.js";

const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const REQ_ID = /^[A-Z0-9]+-[0-9]+$/;

const APPROVAL_RECORD_TYPE = "issue-thread+request_board_approval";

const amendmentRefSchema = z
  .object({
    approvalRecordType: z.string(),
    approvalId: z.string().min(1),
    issueId: z.string().min(1),
    approverRole: z.string().min(1),
  })
  .strict();

const approvalSchema = amendmentRefSchema.extend({
  approvedAt: z.string().min(1).optional(),
  boundContractHash: z.string(),
  boundPlanRevision: z.string().min(1).optional(),
  note: z.string().optional(),
});

const requirementSchema = z
  .object({
    id: z.string(),
    classification: z.enum(["mandatory", "advisory"]),
    behavior: z.string().min(1),
    acceptanceCriteria: z.array(z.string().min(1)).min(1),
    sourceLocations: z
      .array(
        z
          .object({
            location: z.string().min(1),
            excerpt: z.string().min(1),
          })
          .strict(),
      )
      .min(1),
    planRefs: z.array(z.string().min(1)).optional(),
    verificationMethod: z.string().min(1).optional(),
    lifecycle: z.enum(["active", "removed", "superseded"]),
    amendmentRefs: z.array(amendmentRefSchema).optional(),
  })
  .strict();

const contractSchema = z
  .object({
    kind: z.literal("requirements-contract"),
    schemaVersion: z.string(),
    deliveryId: z.string().min(1),
    sources: z
      .array(
        z
          .object({
            ref: z.string().min(1),
            sha256: z.string(),
          })
          .strict(),
      )
      .min(1),
    scopeAuthority: z
      .object({
        authority: z.string().min(1),
        approvalChannel: z.string().min(1),
      })
      .strict(),
    releaseBoundary: z
      .object({
        scope: z.string().min(1),
        preReleaseBoundary: z.string().min(1),
        postDeploymentBoundary: z.string().min(1),
      })
      .strict(),
    noMandatoryScope: z
      .object({
        classification: z.literal("no-mandatory-scope"),
        approval: amendmentRefSchema,
      })
      .strict()
      .optional(),
    requirements: z.array(requirementSchema),
  })
  .strict();

const evidenceSchema = z
  .object({
    requirementId: z.string().min(1),
    criterion: z.string().min(1),
    sourcePathOrArtifact: z.string().min(1),
    method: z.string().min(1),
    outcome: z.string().min(1),
    durableRef: z.string().min(1),
    candidateOrBuildIdentity: z.string().min(1),
  })
  .strict();

const findingSchema = z
  .object({
    requirementId: z.string().min(1),
    result: z.enum(["PASS", "PARTIAL", "MISSING", "UNCERTAIN"]),
    evidence: z.array(evidenceSchema).optional(),
    note: z.string().optional(),
  })
  .strict();

const auditSchema = z
  .object({
    kind: z.literal("requirements-audit"),
    schemaVersion: z.string(),
    deliveryId: z.string().min(1),
    checkpoint: z.enum(["plan", "final"]),
    attempt: z.number().int().min(1).optional(),
    contractRef: z
      .object({
        deliveryId: z.string().min(1),
        contractHash: z.string(),
      })
      .strict(),
    candidate: z
      .object({
        repo: z.string().min(1),
        sha: z.string(),
        baseSha: z.string().optional(),
      })
      .strict()
      .optional(),
    planRef: z
      .object({
        planRevision: z.string().min(1),
        planHash: z.string(),
      })
      .strict()
      .optional(),
    sourceCompleteness: z
      .object({
        accepted: z.boolean(),
        verifierRole: z.string().min(1),
        checkedAt: z.string().min(1).optional(),
        note: z.string().optional(),
      })
      .strict(),
    findings: z.array(findingSchema),
  })
  .strict();

export interface ValidatorInputs {
  /** Exact authoritative contract bytes (UTF-8). Hash is recomputed from these. */
  contractBytes: string | Uint8Array;
  /** Audit JSON text (forbids agent_name even before parsing). */
  auditText: string;
  /** Authenticated publisher metadata, injected by the caller (never from audit). */
  publisher: PublisherAttestation;
  bindings: AuthoritativeBindings;
}

function fail(
  failures: ValidationFailure[],
  kase: ValidationFailure["case"],
  code: string,
  message: string,
): void {
  failures.push({ case: kase, code, message });
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** SHA-256 over the exact bytes, lowercase hex. */
export function sha256HexBytes(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

function isAmendmentRef(v: unknown): v is AmendmentRef {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r["approvalRecordType"] === "string" &&
    typeof r["approvalId"] === "string" &&
    typeof r["issueId"] === "string" &&
    typeof r["approverRole"] === "string"
  );
}

/**
 * A contract citation authorizes a scope change only when a matching
 * authoritative approval record exists in the delivery record (bindings):
 * correct record type, approver is not a self-approval role, and the record
 * binds the CURRENT contract hash (contract-only change invalidates old
 * approval, AC-07). Plan-scoped approvals additionally bind the plan revision.
 */
function checkApprovalAuthorized(
  citation: unknown,
  bindings: AuthoritativeBindings,
  context: string,
): string | null {
  if (!isAmendmentRef(citation)) {
    return `${context}: bare approved_by string or malformed approval citation rejected (authenticated issue-thread + request_board_approval record required)`;
  }
  if (citation.approvalRecordType !== APPROVAL_RECORD_TYPE) {
    return `${context}: approvalRecordType must be ${APPROVAL_RECORD_TYPE}`;
  }
  if (citation.approvalId.length === 0 || citation.issueId.length === 0) {
    return `${context}: approvalId + issueId required`;
  }
  if (bindings.selfApprovalRoles.includes(citation.approverRole)) {
    return `${context}: self-approval by ${citation.approverRole} rejected`;
  }
  const record = bindings.amendmentApprovals.find((a) => a.approvalId === citation.approvalId);
  if (record === undefined) {
    return `${context}: no authoritative approval record for ${JSON.stringify(citation.approvalId)} in the delivery record`;
  }
  if (
    record.approvalRecordType !== APPROVAL_RECORD_TYPE ||
    record.issueId !== citation.issueId ||
    record.approverRole !== citation.approverRole
  ) {
    return `${context}: authoritative approval record does not match the citation`;
  }
  if (record.boundContractHash !== bindings.contractHash) {
    return `${context}: approval binds stale contract hash (contract change invalidates approval)`;
  }
  if (
    typeof record.boundPlanRevision === "string" &&
    bindings.planRevision !== undefined &&
    record.boundPlanRevision !== bindings.planRevision
  ) {
    return `${context}: approval binds stale plan revision (plan change invalidates approval)`;
  }
  return null;
}

function defaultPassingVerdicts(gates: GateInputs): string[] {
  return gates.passingVerdicts ?? ["CLEAN", "GO", "PASS"];
}

export function validateVeeraEligibility(inputs: ValidatorInputs): ValidationResult {
  const failures: ValidationFailure[] = [];
  const { bindings, publisher } = inputs;

  // ---- Case 7: publisher gate FIRST (fail closed) ----
  // Reject any agent_name field in the raw audit text before parsing.
  if (/"agent_name"\s*:/.test(inputs.auditText)) {
    fail(
      failures,
      7,
      "audit.agent_name",
      "audit contains agent_name field: publisher identity must come from authenticated publication metadata, never from the audit document",
    );
  }
  if (!publisher.authenticated) {
    fail(
      failures,
      7,
      "publisher.unauthenticated",
      "audit publisher is not authenticated (fail closed)",
    );
  }
  if (
    bindings.trustedPublishers.length === 0 ||
    !bindings.trustedPublishers.includes(publisher.publisherId)
  ) {
    fail(
      failures,
      7,
      "publisher.untrusted",
      `publisher ${JSON.stringify(publisher.publisherId)} is not in the trusted-publisher allowlist (fail closed; no publisher named yet)`,
    );
  }

  // ---- Case 1: parse + structural schema ----
  const contractParsed = parseJson(
    typeof inputs.contractBytes === "string"
      ? inputs.contractBytes
      : Buffer.from(inputs.contractBytes).toString("utf-8"),
  );
  if (!contractParsed.ok) {
    fail(failures, 1, "contract.malformed", "contract bytes are not valid JSON");
    return { eligible: false, failures };
  }
  const auditParsed = parseJson(inputs.auditText);
  if (!auditParsed.ok) {
    fail(failures, 1, "audit.malformed", "audit text is not valid JSON");
    return { eligible: false, failures };
  }

  // contract_hash must live OUTSIDE the contract: a self-contained hash field
  // is rejected before schema parsing (strict mode would also reject it as case 1).
  const contractRaw = contractParsed.value as Record<string, unknown>;
  if (
    contractRaw !== null &&
    typeof contractRaw === "object" &&
    ("contractHash" in contractRaw || "contract_hash" in contractRaw)
  ) {
    fail(
      failures,
      2,
      "contract.self_hash",
      "contract must not contain its own hash field (contract_hash is stored outside the contract)",
    );
  }

  const contractResult = contractSchema.safeParse(contractParsed.value);
  if (!contractResult.success) {
    fail(
      failures,
      1,
      "contract.schema",
      `contract schema violation: ${contractResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  const auditResult = auditSchema.safeParse(auditParsed.value);
  if (!auditResult.success) {
    fail(
      failures,
      1,
      "audit.schema",
      `audit schema violation: ${auditResult.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  if (failures.some((f) => f.case === 1)) {
    return { eligible: false, failures };
  }
  const contract = contractResult.data as unknown as RequirementsContract;
  const audit = auditResult.data as unknown as RequirementsAudit;

  // ---- Case 1 continued: supported schema versions ----
  if (!SUPPORTED_CONTRACT_SCHEMA_VERSIONS.includes(contract.schemaVersion)) {
    fail(
      failures,
      1,
      "contract.unsupported_schema",
      `unsupported contract schemaVersion ${JSON.stringify(contract.schemaVersion)}`,
    );
  }
  if (!SUPPORTED_AUDIT_SCHEMA_VERSIONS.includes(audit.schemaVersion)) {
    fail(
      failures,
      1,
      "audit.unsupported_schema",
      `unsupported audit schemaVersion ${JSON.stringify(audit.schemaVersion)}`,
    );
  }
  // Hash-format hygiene for source snapshots.
  for (const src of contract.sources) {
    if (!HEX64.test(src.sha256)) {
      fail(
        failures,
        1,
        "contract.source_hash_format",
        `source ${JSON.stringify(src.ref)} has malformed sha256`,
      );
    }
  }

  // ---- Case 2: delivery / repo / SHA / contract-hash / checkpoint bindings ----
  if (contract.deliveryId !== bindings.deliveryId) {
    fail(
      failures,
      2,
      "contract.delivery_mismatch",
      `contract deliveryId ${JSON.stringify(contract.deliveryId)} != authoritative ${JSON.stringify(bindings.deliveryId)}`,
    );
  }
  if (audit.deliveryId !== bindings.deliveryId) {
    fail(
      failures,
      2,
      "audit.delivery_mismatch",
      `audit deliveryId ${JSON.stringify(audit.deliveryId)} != authoritative ${JSON.stringify(bindings.deliveryId)}`,
    );
  }
  if (audit.contractRef.deliveryId !== bindings.deliveryId) {
    fail(
      failures,
      2,
      "audit.contract_ref_delivery_mismatch",
      "audit contractRef.deliveryId != authoritative deliveryId",
    );
  }
  const recomputed = sha256HexBytes(inputs.contractBytes);
  if (recomputed !== bindings.contractHash) {
    fail(
      failures,
      2,
      "contract.hash_mismatch_authoritative",
      "authoritative contract bytes do not match the expected contract hash (delivery record inconsistent)",
    );
  }
  if (audit.contractRef.contractHash !== bindings.contractHash) {
    fail(
      failures,
      2,
      "audit.contract_hash_mismatch",
      "audit binds a different contract hash (contract-only change invalidates old approval)",
    );
  }
  if (recomputed !== audit.contractRef.contractHash) {
    fail(
      failures,
      2,
      "audit.contract_hash_stale",
      "audit contract hash does not match the recomputed authoritative contract hash",
    );
  }
  if (audit.checkpoint !== bindings.checkpoint) {
    fail(
      failures,
      2,
      "audit.checkpoint_mismatch",
      `audit checkpoint ${JSON.stringify(audit.checkpoint)} != authoritative ${JSON.stringify(bindings.checkpoint)}`,
    );
  }
  if (bindings.checkpoint === "final") {
    if (audit.candidate === undefined) {
      fail(failures, 2, "audit.candidate_missing", "final audit is missing candidate binding");
    } else {
      if (audit.candidate.repo !== bindings.repo) {
        fail(
          failures,
          2,
          "candidate.repo_mismatch",
          `candidate repo ${JSON.stringify(audit.candidate.repo)} != authoritative ${JSON.stringify(bindings.repo)}`,
        );
      }
      if (!HEX40.test(audit.candidate.sha)) {
        fail(
          failures,
          2,
          "candidate.sha_format",
          "candidate sha must be a full 40-char hex SHA",
        );
      } else if (audit.candidate.sha !== bindings.candidateSha) {
        fail(
          failures,
          2,
          "candidate.sha_mismatch",
          "approval for SHA-A cannot release SHA-B (changed HEAD invalidates)",
        );
      }
      if (
        audit.candidate.baseSha !== undefined &&
        !HEX40.test(audit.candidate.baseSha)
      ) {
        fail(failures, 2, "candidate.base_sha_format", "candidate baseSha must be full 40-char hex");
      }
    }
  }
  if (
    bindings.checkpoint === "plan" &&
    bindings.planRevision !== undefined &&
    audit.planRef?.planRevision !== bindings.planRevision
  ) {
    fail(
      failures,
      2,
      "plan.revision_mismatch",
      "plan change invalidates old plan approval",
    );
  }
  if (
    bindings.checkpoint === "plan" &&
    bindings.planHash !== undefined &&
    audit.planRef?.planHash !== bindings.planHash
  ) {
    fail(
      failures,
      2,
      "plan.hash_mismatch",
      "plan change invalidates old plan approval",
    );
  }

  // ---- Case 3: mandatory ID set integrity ----
  const activeMandatory = contract.requirements.filter(
    (r) => r.classification === "mandatory" && r.lifecycle === "active",
  );
  const seen = new Map<string, number>();
  for (const r of contract.requirements) {
    seen.set(r.id, (seen.get(r.id) ?? 0) + 1);
    if (!REQ_ID.test(r.id)) {
      fail(failures, 3, "contract.id_format", `requirement id ${JSON.stringify(r.id)} is not a stable ID`);
    }
  }
  for (const [id, count] of seen) {
    if (count > 1) {
      fail(failures, 3, "contract.duplicate_id", `duplicate requirement id ${JSON.stringify(id)}`);
    }
  }
  const contractIds = new Set(contract.requirements.map((r) => r.id));
  const mandatoryIds = new Set(activeMandatory.map((r) => r.id));
  const findingCounts = new Map<string, number>();
  for (const f of audit.findings) {
    findingCounts.set(f.requirementId, (findingCounts.get(f.requirementId) ?? 0) + 1);
    if (!contractIds.has(f.requirementId)) {
      fail(
        failures,
        3,
        "audit.unknown_id",
        `finding for unknown requirement id ${JSON.stringify(f.requirementId)}`,
      );
    }
  }
  for (const [id, count] of findingCounts) {
    if (count > 1) {
      fail(failures, 3, "audit.duplicate_id", `duplicate finding for ${JSON.stringify(id)}`);
    }
  }
  for (const id of mandatoryIds) {
    if (!findingCounts.has(id)) {
      fail(failures, 3, "audit.omitted_mandatory", `omitted mandatory id ${JSON.stringify(id)}`);
    }
  }
  // Unsupported result values cannot reach here structurally (zod enum), but
  // guard the type boundary in case the schema ever widens.
  const allowed: ReadonlySet<string> = new Set(["PASS", "PARTIAL", "MISSING", "UNCERTAIN"]);
  for (const f of audit.findings as AuditFinding[]) {
    if (!allowed.has((f as { result: string }).result)) {
      fail(failures, 3, "audit.result_value", `unsupported result for ${JSON.stringify(f.requirementId)}`);
    }
  }

  // ---- Case 4: due mandatory results + PASS evidence completeness ----
  const dueIds =
    bindings.checkpoint === "final"
      ? mandatoryIds
      : new Set(
          activeMandatory
            .filter((r) => (r.planRefs ?? []).length > 0 || (r.verificationMethod ?? "").length > 0)
            .map((r) => r.id),
        );
  const findingsById = new Map(audit.findings.map((f) => [f.requirementId, f]));
  for (const id of dueIds) {
    const f = findingsById.get(id);
    if (!f) continue; // already reported under case 3
    if (f.result !== "PASS") {
      fail(
        failures,
        4,
        "finding.not_pass",
        `due mandatory ${JSON.stringify(id)} has result ${f.result} (HOLD)`,
      );
      continue;
    }
    const ev = f.evidence ?? [];
    if (ev.length === 0) {
      fail(failures, 4, "finding.pass_without_evidence", `PASS for ${JSON.stringify(id)} has no evidence`);
      continue;
    }
    for (const e of ev) {
      if (e.requirementId !== id) {
        fail(
          failures,
          4,
          "evidence.requirement_binding",
          `evidence for ${JSON.stringify(id)} cites ${JSON.stringify(e.requirementId)}`,
        );
      }
      if (
        bindings.checkpoint === "final" &&
        bindings.candidateSha !== undefined &&
        !e.candidateOrBuildIdentity.includes(bindings.candidateSha)
      ) {
        fail(
          failures,
          4,
          "evidence.candidate_binding",
          `evidence for ${JSON.stringify(id)} is not bound to the pinned candidate SHA`,
        );
      }
    }
  }

  // ---- Case 5: source-completeness explicitly accepted by independent verifier ----
  if (!audit.sourceCompleteness.accepted) {
    fail(failures, 5, "source_completeness.not_accepted", "source completeness not explicitly accepted");
  }
  if (!bindings.independentVerifierRoles.includes(audit.sourceCompleteness.verifierRole)) {
    fail(
      failures,
      5,
      "source_completeness.verifier",
      `source completeness accepted by ${JSON.stringify(audit.sourceCompleteness.verifierRole)}, not an independent verifier`,
    );
  }

  // ---- Case 6: scope authority — removals/supersessions + empty set ----
  for (const r of contract.requirements) {
    if (r.lifecycle === "removed" || r.lifecycle === "superseded") {
      const refs = r.amendmentRefs ?? [];
      if (refs.length === 0) {
        fail(
          failures,
          6,
          "scope.untraceable_change",
          `${r.lifecycle} requirement ${JSON.stringify(r.id)} has no amendment ref`,
        );
        continue;
      }
      for (const a of refs) {
        const problem = checkApprovalAuthorized(a, bindings, `scope change for ${r.id}`);
        if (problem) fail(failures, 6, "scope.unauthorized_change", problem);
      }
    }
  }
  if (activeMandatory.length === 0) {
    const nm = contract.noMandatoryScope;
    if (nm === undefined || nm.classification !== "no-mandatory-scope") {
      fail(
        failures,
        6,
        "scope.unauthorized_empty_set",
        "empty mandatory set without explicit authorized no-mandatory-scope classification rejected",
      );
    } else {
      const problem = checkApprovalAuthorized(nm.approval, bindings, "no-mandatory-scope");
      if (problem) fail(failures, 6, "scope.unauthorized_empty_set", problem);
    }
  }

  // ---- Case 8: required Rehti/QA gates for the candidate ----
  const passing = defaultPassingVerdicts(bindings.gates);
  const gates = bindings.gates;
  if (gates.rehti === undefined) {
    fail(failures, 8, "gates.rehti_missing", "missing required Rehti gate verdict for the candidate");
  } else {
    if (!passing.includes(gates.rehti.verdict)) {
      fail(
        failures,
        8,
        "gates.rehti_not_passing",
        `Rehti verdict ${JSON.stringify(gates.rehti.verdict)} is not passing`,
      );
    }
    if (
      bindings.checkpoint === "final" &&
      bindings.candidateSha !== undefined &&
      gates.rehti.headSha !== bindings.candidateSha
    ) {
      fail(failures, 8, "gates.rehti_stale", "Rehti verdict is for a different HEAD (changed HEAD invalidates)");
    }
  }
  if (gates.qa === undefined) {
    fail(failures, 8, "gates.qa_missing", "missing required QA gate verdict for the candidate");
  } else {
    if (!passing.includes(gates.qa.verdict)) {
      fail(
        failures,
        8,
        "gates.qa_not_passing",
        `QA verdict ${JSON.stringify(gates.qa.verdict)} is not passing`,
      );
    }
    if (
      bindings.checkpoint === "final" &&
      bindings.candidateSha !== undefined &&
      gates.qa.headSha !== bindings.candidateSha
    ) {
      fail(failures, 8, "gates.qa_stale", "QA verdict is for a different HEAD (changed HEAD invalidates)");
    }
  }

  return { eligible: failures.length === 0, failures };
}
