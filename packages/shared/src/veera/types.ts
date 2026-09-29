/**
 * Veera T2 — contract/audit/report types (JES-153, PRD sections 4, 5, 8).
 *
 * contract_hash = SHA-256 over the exact authoritative UTF-8 contract bytes,
 * stored OUTSIDE the contract. The validator always recomputes it from the
 * authoritative bytes it is given and never trusts a candidate-chosen path.
 */

export const VEERA_CONTRACT_SCHEMA_VERSION = "1.0.0" as const;
export const VEERA_AUDIT_SCHEMA_VERSION = "1.0.0" as const;

/** Schema versions this validator accepts. Anything else is rejected (case 1). */
export const SUPPORTED_CONTRACT_SCHEMA_VERSIONS: readonly string[] = [
  VEERA_CONTRACT_SCHEMA_VERSION,
];
export const SUPPORTED_AUDIT_SCHEMA_VERSIONS: readonly string[] = [
  VEERA_AUDIT_SCHEMA_VERSION,
];

export type RequirementClassification = "mandatory" | "advisory";
export type RequirementLifecycle = "active" | "removed" | "superseded";
export type AuditResult = "PASS" | "PARTIAL" | "MISSING" | "UNCERTAIN";
export type Checkpoint = "plan" | "final";

/**
 * Citation of a scope approval, stored in the contract. The authoritative
 * approval record (with bound hashes) lives in the delivery record (issue
 * thread + request_board_approval) and is supplied via bindings — never
 * trusted from the contract text alone. A bare approved_by string is rejected.
 */
export interface AmendmentRef {
  /** Must be "issue-thread+request_board_approval". */
  approvalRecordType: string;
  approvalId: string;
  issueId: string;
  /** Role that approved. Implementer / Veera self-approval is rejected. */
  approverRole: string;
}

export interface AuthenticatedApproval extends AmendmentRef {
  approvedAt?: string;
  /** Contract hash the approval was issued against (from the delivery record). */
  boundContractHash: string;
  boundPlanRevision?: string;
  note?: string;
}

export interface Requirement {
  id: string;
  classification: RequirementClassification;
  behavior: string;
  acceptanceCriteria: string[];
  sourceLocations: Array<{ location: string; excerpt: string }>;
  planRefs?: string[];
  verificationMethod?: string;
  lifecycle: RequirementLifecycle;
  amendmentRefs?: AmendmentRef[];
}

export interface RequirementsContract {
  kind: "requirements-contract";
  schemaVersion: string;
  deliveryId: string;
  sources: Array<{ ref: string; sha256: string }>;
  scopeAuthority: { authority: string; approvalChannel: string };
  releaseBoundary: {
    scope: string;
    preReleaseBoundary: string;
    postDeploymentBoundary: string;
  };
  noMandatoryScope?: {
    classification: "no-mandatory-scope";
    approval: AmendmentRef;
  };
  requirements: Requirement[];
}

export interface AuditEvidence {
  requirementId: string;
  criterion: string;
  sourcePathOrArtifact: string;
  method: string;
  outcome: string;
  durableRef: string;
  candidateOrBuildIdentity: string;
}

export interface AuditFinding {
  requirementId: string;
  result: AuditResult;
  evidence?: AuditEvidence[];
  note?: string;
}

export interface RequirementsAudit {
  kind: "requirements-audit";
  schemaVersion: string;
  deliveryId: string;
  checkpoint: Checkpoint;
  attempt?: number;
  contractRef: { deliveryId: string; contractHash: string };
  candidate?: { repo: string; sha: string; baseSha?: string };
  planRef?: { planRevision: string; planHash: string };
  sourceCompleteness: {
    accepted: boolean;
    verifierRole: string;
    checkedAt?: string;
    note?: string;
  };
  findings: AuditFinding[];
}

/**
 * Publisher attestation from AUTHENTICATED execution/publication metadata
 * (e.g. CI identity / protected artifact publisher). Injected by the caller —
 * never read from an `agent_name` field inside the audit (rejected, case 7).
 */
export interface PublisherAttestation {
  publisherId: string;
  authenticated: boolean;
}

/**
 * Required technical-review / QA gate verdicts for the candidate, consumed
 * from the trusted delivery record (case 8). Rehti stays the formal reviewer
 * (R1); the validator consumes verdicts, it does not re-review.
 */
export interface GateVerdict {
  /** CLEAN / GO vs anything else. */
  verdict: string;
  /** Full 40-char SHA the verdict was issued against. Changed HEAD invalidates. */
  headSha: string;
}

export interface GateInputs {
  rehti?: GateVerdict;
  qa?: GateVerdict;
  /** Verdict strings that count as passing (default: CLEAN, GO, PASS). */
  passingVerdicts?: string[];
}

/**
 * Authoritative bindings the validator checks the artifacts against.
 * All values come from the trusted delivery record — never from the candidate.
 */
export interface AuthoritativeBindings {
  deliveryId: string;
  /** Expected contract hash (SHA-256 over exact authoritative contract bytes). */
  contractHash: string;
  checkpoint: Checkpoint;
  /** Final checkpoint only. */
  repo?: string;
  candidateSha?: string;
  /** Plan checkpoint only (AC-07: plan change invalidates old plan approval). */
  planRevision?: string;
  planHash?: string;
  /** Explicit trusted-publisher allowlist. Empty = fail closed (B3: no publisher named yet). */
  trustedPublishers: string[];
  /** Roles that count as the independent verifier for source-completeness (case 5). */
  independentVerifierRoles: string[];
  /** Roles that may never approve scope reductions (implementer / Veera self-approval). */
  selfApprovalRoles: string[];
  /**
   * Authoritative approval records from the delivery record (issue thread +
   * request_board_approval). Contract amendmentRefs are citations; they
   * authorize a change only when a matching authoritative record exists here.
   */
  amendmentApprovals: AuthenticatedApproval[];
  gates: GateInputs;
}

export interface ValidationFailure {
  /** PRD section 8 case number (1-8). */
  case: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  code: string;
  message: string;
}

export interface ValidationResult {
  eligible: boolean;
  failures: ValidationFailure[];
}
