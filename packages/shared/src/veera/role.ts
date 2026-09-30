/**
 * Veera T3 — role definition (JES-156, PRD sections 3, 4).
 *
 * Machine-readable Veera role definition. Veera is the independent verifier:
 * a separate `pi_local` role/session with its own cwd. It judges evidence and
 * routes corrections; it never implements product fixes and never approves
 * its own scope reductions (R1, R6).
 *
 * No clock, no randomness, no I/O. No live agent is hired or activated here —
 * activation + live run belong to T5 (AC-01 verified live there).
 */

export const VEERA_ROLE_NAME = "Veera" as const;
export const VEERA_ADAPTER_TYPE = "pi_local" as const;
export const VEERA_PI_BINARY = "/home/eljese/.local/bin/pi" as const;

/** Roles that may never approve scope reductions (implementer / Veera self-approval). */
export const VEERA_SELF_APPROVAL_ROLES: readonly string[] = [
  "implementer",
  "Veera",
  "veera",
] as const;

/** Roles that count as the independent verifier for source-completeness. */
export const VEERA_INDEPENDENT_VERIFIER_ROLES: readonly string[] = [
  "Veera",
] as const;

export interface VeeraRoleDefinition {
  name: typeof VEERA_ROLE_NAME;
  adapterType: typeof VEERA_ADAPTER_TYPE;
  /** Veera must run in a separate session with its own cwd, never the implementer's session. */
  separateSession: true;
  separateCwd: true;
  /** Permission exclusions: Veera never holds these capabilities. */
  permissionExclusions: {
    noProductCodeWrites: true;
    noSelfApproval: true;
    noScopeReductionApproval: true;
  };
  /** What Veera may produce: read-only checks + verification artifacts only. */
  allowedOutputs: readonly ["audit-findings", "verification-artifacts", "hold-routing"];
}

export const VEERA_ROLE: VeeraRoleDefinition = {
  name: VEERA_ROLE_NAME,
  adapterType: VEERA_ADAPTER_TYPE,
  separateSession: true,
  separateCwd: true,
  permissionExclusions: {
    noProductCodeWrites: true,
    noSelfApproval: true,
    noScopeReductionApproval: true,
  },
  allowedOutputs: ["audit-findings", "verification-artifacts", "hold-routing"],
};

/**
 * Exact provisioning payload for the existing agent-provisioning path
 * (hire via the standard flow). This task only defines the spec — it does
 * NOT hire or activate a live agent.
 */
export interface VeeraProvisioningPayload {
  action: "hire";
  name: typeof VEERA_ROLE_NAME;
  adapterType: typeof VEERA_ADAPTER_TYPE;
  separateCwd: true;
  instructionsRef: "packages/shared/src/veera/veera-instructions.md";
  permissionExclusions: VeeraRoleDefinition["permissionExclusions"];
}

export const VEERA_PROVISIONING_PAYLOAD: VeeraProvisioningPayload = {
  action: "hire",
  name: VEERA_ROLE_NAME,
  adapterType: VEERA_ADAPTER_TYPE,
  separateCwd: true,
  instructionsRef: "packages/shared/src/veera/veera-instructions.md",
  permissionExclusions: VEERA_ROLE.permissionExclusions,
};

/** Returns a fresh copy of the provisioning payload (caller may set cwd/session). */
export function buildVeeraProvisioningPayload(): VeeraProvisioningPayload {
  return {
    ...VEERA_PROVISIONING_PAYLOAD,
    permissionExclusions: { ...VEERA_PROVISIONING_PAYLOAD.permissionExclusions },
  };
}
