/**
 * Veera T4 — release + parent-completion enforcement tests (JES-149).
 *
 * These tests exercise the REAL entry points (`evaluateReleaseGate`,
 * `evaluateCompletionGate`, the `scripts/veera-gate.mjs` command, and the
 * `scripts/release.sh` wiring) — never the T2 validator alone (AC-10).
 * Covers AC-11 (multi-PR + production-only), AC-14 (moved candidate blocks;
 * only the pinned candidate releases) and AC-07 (contract-only change and
 * plan change invalidate old approval, through the gates).
 *
 * Deterministic: pure fixtures, no clock, no randomness. The CLI
 * subprocess tests use a throwaway local git repo only to prove the
 * pinned-SHA re-check reads the actually-observed HEAD.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  evaluateCompletionGate,
  type CompletionGateInputs,
} from "./completion-gate.js";
import {
  evaluateReleaseGate,
  type ReleaseGateInputs,
} from "./release-gate.js";
import type {
  AuthoritativeBindings,
  PublisherAttestation,
  RequirementsAudit,
  RequirementsContract,
} from "./types.js";
import { sha256HexBytes } from "./validator.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..", "..");

const CAND_A = "a".repeat(40);
const CAND_B = "b".repeat(40);
const BASE = "c".repeat(40);
const SRC_HASH = "0".repeat(64);
const REPO = "github.com/eljese/paperclip";

const TRUSTED_PUBLISHER = "ci-protected-publisher";
const publisher: PublisherAttestation = {
  publisherId: TRUSTED_PUBLISHER,
  authenticated: true,
};

function requirement(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    classification: "mandatory",
    behavior: `behavior ${id}`,
    acceptanceCriteria: [`criterion ${id}`],
    sourceLocations: [{ location: "PRD s1", excerpt: `must satisfy ${id}` }],
    planRefs: ["T1"],
    verificationMethod: "inspect candidate build",
    lifecycle: "active",
    ...extra,
  };
}

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
    requirements: [requirement("JES-1") as RequirementsContract["requirements"][number]],
    ...extra,
  };
}

function evidence(candidateSha: string, requirementId = "JES-1") {
  return {
    requirementId,
    criterion: `criterion ${requirementId}`,
    sourcePathOrArtifact: "packages/shared/src/veera/x.ts",
    method: "inspect candidate build",
    outcome: "observed",
    durableRef: "ci-artifact:run-1",
    candidateOrBuildIdentity: `${REPO} @ ${candidateSha}`,
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
    candidate: { repo: REPO, sha: CAND_A, baseSha: BASE },
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
    repo: REPO,
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

function releaseFixture(
  overrides: {
    contract?: Partial<RequirementsContract>;
    audit?: Partial<RequirementsAudit>;
    bindings?: Partial<AuthoritativeBindings>;
    actualHeadSha?: string;
    pinnedCandidateSha?: string;
    deployArtifactSha?: string;
    releaseRepo?: string;
    releaseKind?: ReleaseGateInputs["releaseKind"];
    postDeploymentRequirementIds?: string[];
  } = {},
): ReleaseGateInputs {
  const contractBytes = JSON.stringify(contractDoc(overrides.contract));
  const hash = sha256HexBytes(contractBytes);
  const audit = auditDoc(hash, overrides.audit);
  if (overrides.audit?.contractRef === undefined) {
    audit.contractRef = { deliveryId: audit.deliveryId, contractHash: hash };
  }
  return {
    contractBytes,
    auditText: JSON.stringify(audit),
    publisher,
    bindings: bindings(hash, overrides.bindings),
    actualHeadSha: overrides.actualHeadSha ?? CAND_A,
    pinnedCandidateSha: overrides.pinnedCandidateSha ?? CAND_A,
    deployArtifactSha: overrides.deployArtifactSha,
    releaseRepo: overrides.releaseRepo ?? REPO,
    releaseKind: overrides.releaseKind ?? "scoped",
    postDeploymentRequirementIds: overrides.postDeploymentRequirementIds,
  };
}

function writeGateFiles(f: ReleaseGateInputs | CompletionGateInputs): {
  contract: string;
  audit: string;
  bindings: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "veera-gate-e2e-"));
  const contract = join(dir, "contract.json");
  const audit = join(dir, "audit.json");
  const bindings = join(dir, "bindings.json");
  writeFileSync(
    contract,
    typeof f.contractBytes === "string" ? f.contractBytes : Buffer.from(f.contractBytes),
  );
  writeFileSync(audit, f.auditText);
  writeFileSync(bindings, JSON.stringify(f.bindings));
  return { contract, audit, bindings };
}

function makeGitRepo(): { dir: string; head: string } {
  const dir = mkdtempSync(join(tmpdir(), "veera-gate-repo-"));
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "config", "user.email", "veera-test@example.invalid"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "veera-test"]);
  writeFileSync(join(dir, "candidate.txt"), "candidate");
  execFileSync("git", ["-C", dir, "add", "."]);
  execFileSync("git", ["-C", dir, "commit", "-qm", "candidate"]);
  const head = execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], {
    encoding: "utf-8",
  }).trim();
  return { dir, head };
}

function execGate(args: string[]): { status: number | null; stdout: string } {
  try {
    const stdout = execFileSync("node", [join(REPO_ROOT, "scripts", "veera-gate.mjs"), ...args], {
      encoding: "utf-8",
      timeout: 60000,
    });
    return { status: 0, stdout };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string };
    return { status: e.status ?? null, stdout: (e.stdout as string) ?? "" };
  }
}

function completionFixture(
  overrides: {
    contract?: Partial<RequirementsContract>;
    audit?: Partial<RequirementsAudit>;
    bindings?: Partial<AuthoritativeBindings>;
    deployedSha?: string;
    pinnedCandidateSha?: string;
  } = {},
): CompletionGateInputs {
  const r = releaseFixture(overrides);
  return {
    contractBytes: r.contractBytes,
    auditText: r.auditText,
    publisher: r.publisher,
    bindings: r.bindings,
    parentDeliveryId: "JES-000",
    deployedSha: overrides.deployedSha ?? CAND_A,
    pinnedCandidateSha: overrides.pinnedCandidateSha ?? CAND_A,
  };
}

describe("veera release gate (real pre-deployment entry point)", () => {
  it("PASS releases the pinned candidate (AC-10/AC-14)", () => {
    const result = evaluateReleaseGate(releaseFixture());
    expect(result.verdict).toBe("PASS");
    expect(result.blocks).toEqual([]);
    expect(result.gatedSha).toBe(CAND_A);
    expect(result.deploymentOnly).toBe(false);
  });

  it("is deterministic: same inputs give identical outputs", () => {
    expect(evaluateReleaseGate(releaseFixture())).toEqual(
      evaluateReleaseGate(releaseFixture()),
    );
  });

  it("moved candidate blocks release even with a valid audit (AC-14)", () => {
    // Squash/merge/rebase produced CAND_B; approval was for CAND_A.
    const result = evaluateReleaseGate(releaseFixture({ actualHeadSha: CAND_B }));
    expect(result.verdict).toBe("HOLD");
    expect(result.blocks.some((b) => b.code === "release.candidate_moved")).toBe(true);
    expect(result.gatedSha).toBeNull();
  });

  it("only the pinned approved artifact may deploy (AC-14)", () => {
    const result = evaluateReleaseGate(
      releaseFixture({ deployArtifactSha: CAND_B }),
    );
    expect(result.verdict).toBe("HOLD");
    expect(result.blocks.some((b) => b.code === "release.deploy_not_pinned")).toBe(true);
  });

  it("stale approval binding blocks: pinned SHA differs from authoritative binding", () => {
    const result = evaluateReleaseGate(
      releaseFixture({
        actualHeadSha: CAND_B,
        pinnedCandidateSha: CAND_B,
        // bindings still approve CAND_A
      }),
    );
    expect(result.verdict).toBe("HOLD");
    expect(
      result.blocks.some((b) => b.code === "release.pinned_binding_mismatch"),
    ).toBe(true);
  });

  it("missing/HOLD audit blocks scoped release (AC-10)", () => {
    const result = evaluateReleaseGate(
      releaseFixture({
        audit: { findings: [{ requirementId: "JES-1", result: "MISSING" }] },
      }),
    );
    expect(result.verdict).toBe("HOLD");
    expect(result.blocks.length).toBeGreaterThan(0);
  });

  it("contract-only change invalidates the old approval through the gate (AC-07)", () => {
    const f = releaseFixture();
    // Code unchanged (same SHAs) but the contract text changed after approval:
    // recomputed hash no longer matches the authoritative approved hash.
    const before = typeof f.contractBytes === "string" ? f.contractBytes : Buffer.from(f.contractBytes).toString("utf-8");
    const changed = JSON.stringify({
      ...JSON.parse(before),
      releaseBoundary: {
        scope: "CHANGED scope",
        preReleaseBoundary: "pre",
        postDeploymentBoundary: "post",
      },
    });
    const result = evaluateReleaseGate({ ...f, contractBytes: changed });
    expect(result.verdict).toBe("HOLD");
    expect(
      result.blocks.some((b) => b.code === "contract.hash_mismatch_authoritative"),
    ).toBe(true);
  });

  it("plan change invalidates the old plan approval through the gate (AC-07)", () => {
    const f = releaseFixture({
      bindings: {
        checkpoint: "plan",
        repo: undefined,
        candidateSha: undefined,
        planRevision: "rev-2",
        planHash: "d".repeat(64),
        gates: {
          rehti: { verdict: "CLEAN", headSha: CAND_A },
          qa: { verdict: "PASS", headSha: CAND_A },
        },
      },
      audit: { checkpoint: "plan", candidate: undefined, planRef: { planRevision: "rev-1", planHash: "d".repeat(64) } },
    });
    const result = evaluateReleaseGate(f);
    expect(result.verdict).toBe("HOLD");
    expect(result.blocks.some((b) => b.code === "plan.revision_mismatch")).toBe(true);
  });
});

describe("veera multi-PR rule (AC-11)", () => {
  it("intermediate releases pass through under existing gates, never as approval", () => {
    const holdAudit = {
      findings: [{ requirementId: "JES-1", result: "MISSING" as const }],
    };
    const intermediate = evaluateReleaseGate(
      releaseFixture({ releaseKind: "intermediate", audit: holdAudit }),
    );
    expect(intermediate.verdict).toBe("NOT_APPLICABLE");
    expect(intermediate.gatedSha).toBeNull();

    // The same HOLD audit still blocks scoped release and parent completion.
    expect(evaluateReleaseGate(releaseFixture({ audit: holdAudit })).verdict).toBe("HOLD");
    expect(
      evaluateCompletionGate(completionFixture({ audit: holdAudit })).verdict,
    ).toBe("HOLD");
  });
});

describe("veera production-only rule (AC-11)", () => {
  const TWO_REQS = {
    requirements: [
      requirement("JES-1"),
      requirement("JES-2"),
    ] as RequirementsContract["requirements"],
  };
  function postPending() {
    return releaseFixture({
      contract: TWO_REQS,
      audit: {
        findings: [
          { requirementId: "JES-1", result: "PASS", evidence: [evidence(CAND_A, "JES-1")] },
          { requirementId: "JES-2", result: "UNCERTAIN", note: "post-deployment check pending" },
        ],
      },
      postDeploymentRequirementIds: ["JES-2"],
    });
  }

  it("pending production-only check authorizes deployment but blocks completion", () => {
    const release = evaluateReleaseGate(postPending());
    expect(release.verdict).toBe("PASS");
    expect(release.deploymentOnly).toBe(true);

    const completion = evaluateCompletionGate(completionFixture({
      contract: TWO_REQS,
      audit: {
        findings: [
          { requirementId: "JES-1", result: "PASS", evidence: [evidence(CAND_A, "JES-1")] },
          { requirementId: "JES-2", result: "UNCERTAIN", note: "post-deployment check pending" },
        ],
      },
    }));
    expect(completion.verdict).toBe("HOLD");
  });

  it("undeclared pending mandatory still blocks deployment (no silent carve-out)", () => {
    const release = evaluateReleaseGate({
      ...postPending(),
      postDeploymentRequirementIds: [],
    });
    expect(release.verdict).toBe("HOLD");
  });

  it("fix-then-complete replay: fresh PASS audit bound to the deployed SHA completes (AC-14)", () => {
    const completion = evaluateCompletionGate(
      completionFixture({
        contract: TWO_REQS,
        audit: {
          attempt: 2,
          findings: [
            { requirementId: "JES-1", result: "PASS", evidence: [evidence(CAND_A, "JES-1")] },
            { requirementId: "JES-2", result: "PASS", evidence: [evidence(CAND_A, "JES-2")] },
          ],
        },
      }),
    );
    expect(completion.verdict).toBe("PASS");
  });
});

describe("veera completion gate (controlled parent-delivery path)", () => {
  it("PASS completes the parent for the pinned deployment", () => {
    const result = evaluateCompletionGate(completionFixture());
    expect(result.verdict).toBe("PASS");
    expect(result.blocks).toEqual([]);
  });

  it("deployed SHA differing from pinned blocks completion (AC-14)", () => {
    const result = evaluateCompletionGate(completionFixture({ deployedSha: CAND_B }));
    expect(result.verdict).toBe("HOLD");
    expect(result.blocks.some((b) => b.code === "completion.deployed_not_pinned")).toBe(true);
  });

  it("wrong parent delivery ID blocks completion", () => {
    const result = evaluateCompletionGate({
      ...completionFixture(),
      parentDeliveryId: "JES-999",
    });
    expect(result.verdict).toBe("HOLD");
    expect(result.blocks.some((b) => b.code === "completion.delivery_mismatch")).toBe(true);
  });
});

describe("veera real command wiring (AC-10)", () => {
  it("scripts/release.sh invokes the Veera pre-deployment gate", () => {
    const releaseSh = readFileSync(join(REPO_ROOT, "scripts", "release.sh"), "utf-8");
    expect(releaseSh).toContain("veera-gate.mjs");
    expect(releaseSh).toContain("VEERA_DELIVERY_ID");
  });

  it("veera-gate.mjs fails closed on missing evidence files (exit 2)", () => {
    const dir = mkdtempSync(join(tmpdir(), "veera-gate-missing-"));
    const run = execGate(["--mode", "release", "--contract", join(dir, "nope.json")]);
    expect(run.status).toBe(2);
  });
});

describe("veera-gate.mjs end to end against real git HEAD (AC-10/AC-14)", () => {
  it("release PASS prints VEERA_GATED_SHA for the observed HEAD", () => {
    const repo = makeGitRepo();
    const f = releaseFixture({
      actualHeadSha: repo.head,
      pinnedCandidateSha: repo.head,
      audit: {
        candidate: { repo: REPO, sha: repo.head, baseSha: BASE },
        findings: [{ requirementId: "JES-1", result: "PASS", evidence: [evidence(repo.head)] }],
      },
      bindings: {
        candidateSha: repo.head,
        gates: {
          rehti: { verdict: "CLEAN", headSha: repo.head },
          qa: { verdict: "PASS", headSha: repo.head },
        },
      },
    });
    const files = writeGateFiles(f);
    const run = execGate([
      "--mode", "release",
      "--contract", files.contract,
      "--audit", files.audit,
      "--bindings", files.bindings,
      "--pinned", repo.head,
      "--repo-dir", repo.dir,
      "--publisher-id", TRUSTED_PUBLISHER,
      "--publisher-authenticated", "1",
    ]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`VEERA_GATED_SHA=${repo.head}`);
  }, 30000);

  it("moved candidate blocks release through the real command", () => {
    const repo = makeGitRepo();
    const f = releaseFixture({ actualHeadSha: CAND_A, pinnedCandidateSha: CAND_A });
    const files = writeGateFiles(f);
    // HEAD just moved (repo.head is fresh); the old pin no longer matches.
    const run = execGate([
      "--mode", "release",
      "--contract", files.contract,
      "--audit", files.audit,
      "--bindings", files.bindings,
      "--pinned", CAND_A,
      "--repo-dir", repo.dir,
      "--publisher-id", TRUSTED_PUBLISHER,
      "--publisher-authenticated", "1",
    ]);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("release.candidate_moved");
  }, 30000);

  it("completion PASS authorizes the parent close through the real command", () => {
    const f = completionFixture();
    const files = writeGateFiles(f);
    const run = execGate([
      "--mode", "completion",
      "--contract", files.contract,
      "--audit", files.audit,
      "--bindings", files.bindings,
      "--pinned", CAND_A,
      "--parent-delivery", "JES-000",
      "--deployed", CAND_A,
      "--publisher-id", TRUSTED_PUBLISHER,
      "--publisher-authenticated", "1",
    ]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("parent completion authorized");
  }, 30000);

  it("completion with unpinned deployment blocks through the real command", () => {
    const f = completionFixture();
    const files = writeGateFiles(f);
    const run = execGate([
      "--mode", "completion",
      "--contract", files.contract,
      "--audit", files.audit,
      "--bindings", files.bindings,
      "--pinned", CAND_A,
      "--parent-delivery", "JES-000",
      "--deployed", CAND_B,
      "--publisher-id", TRUSTED_PUBLISHER,
      "--publisher-authenticated", "1",
    ]);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("completion.deployed_not_pinned");
  }, 30000);
});
