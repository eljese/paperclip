/**
 * Veera T3 — pstack handoff adaptation (JES-156, PRD section 9).
 *
 * Adapts the handoff fields through the WORKING Pi adapter (`pi_local`,
 * `/home/eljese/.local/bin/pi`). Rehti verdicts are consumed as gate inputs
 * (R1); `interrogate` / `arena` are optional-only flags — never mandatory and
 * never a duplicate review panel (AC-12).
 *
 * Adopted pstack revision: the T1 pin `74dd2291e8e37b12fd6dc49b2acbd655c6bdaf12`
 * (`poteto/plugins` `main` as of 2026-09-29). At implementation time the
 * working repo `github.com/eljese/paperclip` contains no `path:pstack`
 * component to re-resolve, so the T1 pin is carried forward unchanged and
 * recorded here plus in the PR description.
 */

export const ADOPTED_PSTACK_REV = "74dd2291e8e37b12fd6dc49b2acbd655c6bdaf12" as const;
export const ADOPTED_PSTACK_SOURCE = "poteto/plugins main as of 2026-09-29 (T1 pin)" as const;

export const VEERA_PI_ADAPTER = "pi_local" as const;
export const VEERA_PI_BINARY = "/home/eljese/.local/bin/pi" as const;

export interface VeeraHandoffRequirement {
  id: string;
  acceptanceCriteria: string[];
}

export interface VeeraHandoff {
  adapter: typeof VEERA_PI_ADAPTER;
  deliveryId: string;
  contractRef: string;
  contractHash: string;
  requirements: VeeraHandoffRequirement[];
  workBoundaries: string;
  expectedEvidence: string[];
  candidateSha: string;
  evidenceLinks: string[];
  unresolvedBlockers: string[];
  consumedBudget: number;
  /** Rehti verdict consumed as a gate input (R1), never re-reviewed. */
  rehtiVerdict?: { verdict: string; headSha: string };
  /** Optional-only: must never be required, never a duplicate review panel. */
  interrogate?: boolean;
  /** Optional-only: must never be required, never a duplicate review panel. */
  arena?: boolean;
}

export interface HandoffValidation {
  valid: boolean;
  problems: string[];
}

/**
 * Builds a handoff record. Pure: validates nothing, just shapes the fields.
 * Use `validateHandoff` to enforce completeness before sending.
 */
export function buildVeeraHandoff(input: Omit<VeeraHandoff, "adapter">): VeeraHandoff {
  return { ...input, adapter: VEERA_PI_ADAPTER };
}

/**
 * Validates a handoff: all required fields present, and interrogate/arena
 * are never mandatory. Returns every problem found (fail-closed list).
 */
export function validateHandoff(handoff: VeeraHandoff): HandoffValidation {
  const problems: string[] = [];
  if (handoff.adapter !== VEERA_PI_ADAPTER) {
    problems.push(`adapter must be ${VEERA_PI_ADAPTER}`);
  }
  if (handoff.deliveryId.trim().length === 0) problems.push("deliveryId is required");
  if (handoff.contractRef.trim().length === 0) problems.push("contractRef is required");
  if (!/^[0-9a-f]{64}$/.test(handoff.contractHash)) {
    problems.push("contractHash must be a 64-char hex SHA-256");
  }
  if (handoff.requirements.length === 0) {
    problems.push("at least one assigned requirement ID is required");
  }
  for (const req of handoff.requirements) {
    if (req.id.trim().length === 0) problems.push("requirement id must not be blank");
    if (req.acceptanceCriteria.length === 0) {
      problems.push(`requirement ${JSON.stringify(req.id)} carries no acceptance criteria`);
    }
  }
  if (handoff.workBoundaries.trim().length === 0) problems.push("workBoundaries are required");
  if (handoff.expectedEvidence.length === 0) problems.push("expectedEvidence is required");
  if (!/^[0-9a-f]{40}$/.test(handoff.candidateSha)) {
    problems.push("candidateSha must be a full 40-char hex SHA");
  }
  return { valid: problems.length === 0, problems };
}

/**
 * Guards the optional-only flags: interrogate/arena may be present but must
 * never be treated as mandatory. Any policy object marking them required is
 * rejected here so they can never become a duplicate review panel.
 */
export function optionalFlagsAreMandatory(policy: {
  requireInterrogate?: boolean;
  requireArena?: boolean;
}): boolean {
  return policy.requireInterrogate === true || policy.requireArena === true;
}
