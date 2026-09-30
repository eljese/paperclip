/**
 * Veera T2 — public module surface (JES-153).
 */
export * from "./types.js";
export { sha256HexBytes, validateVeeraEligibility, type ValidatorInputs } from "./validator.js";
export { renderAuditReport, type ReportInputs } from "./report.js";
export {
  VEERA_ROLE,
  VEERA_ROLE_NAME,
  VEERA_ADAPTER_TYPE,
  VEERA_PI_BINARY,
  VEERA_SELF_APPROVAL_ROLES,
  VEERA_INDEPENDENT_VERIFIER_ROLES,
  VEERA_PROVISIONING_PAYLOAD,
  buildVeeraProvisioningPayload,
  type VeeraRoleDefinition,
  type VeeraProvisioningPayload,
} from "./role.js";
export {
  checkSourceCompleteness,
  toAuditSourceCompleteness,
  type SourceCommitment,
  type CommitmentMapping,
  type SourceCompletenessResult,
  type PlanFinalDecision,
} from "./source-completeness.js";
export {
  assessPlanCheckpoint,
  blocksHandoff,
  type PlanCheckpointInput,
  type PlanCheckpointFinding,
  type PlanCheckpointResult,
  type ReleasePhase,
} from "./plan-checkpoint.js";
export {
  assessFinalCheckpoint,
  assessRequirementEvidence,
  assessReusedEvidence,
  type FinalCheckpointRequirement,
  type FinalCheckpointFinding,
  type FinalCheckpointResult,
  type FinalCheckpointInputs,
  type ReusedEvidence,
} from "./final-checkpoint.js";
export {
  ADOPTED_PSTACK_REV,
  ADOPTED_PSTACK_SOURCE,
  VEERA_PI_ADAPTER,
  buildVeeraHandoff,
  validateHandoff,
  optionalFlagsAreMandatory,
  type VeeraHandoff,
  type VeeraHandoffRequirement,
  type HandoffValidation,
} from "./handoff.js";
export {
  DEFAULT_MAX_AUTOMATIC_CORRECTIONS,
  MAX_CONSECUTIVE_NO_PROGRESS,
  MAX_INFRA_RETRIES,
  HOLD_ROUTING_TABLE,
  routeHold,
  isBlockedCategory,
  maxAutomaticRounds,
  consumeCorrectionRound,
  recordInfraRetry,
  dedupKey,
  shouldCreateTask,
  type HoldCategory,
  type HoldOwner,
  type CorrectionLedger,
  type CorrectionDecision,
} from "./routing.js";
export {
  evaluateReleaseGate,
  type ReleaseKind,
  type ReleaseVerdict,
  type ReleaseGateInputs,
  type ReleaseGateResult,
  type GateBlock,
} from "./release-gate.js";
export {
  evaluateCompletionGate,
  type CompletionVerdict,
  type CompletionGateInputs,
  type CompletionGateResult,
  type CompletionBlock,
} from "./completion-gate.js";
