/**
 * Veera T4 — gate CLI implementation (JES-149).
 *
 * Invoked ONLY through `scripts/veera-gate.mjs` (which resolves the
 * pinned-SHA inputs from git immediately before execution and fails closed
 * when this runtime is unavailable). Reads contract/audit/bindings files,
 * evaluates the real release or completion entry point
 * (`evaluateReleaseGate` / `evaluateCompletionGate`), prints the verdict,
 * and exits 0 (PASS or intermediate NOT_APPLICABLE), 1 (HOLD/blocked) or
 * 2 (usage/config error — fail closed).
 *
 * On release PASS prints `VEERA_GATED_SHA=<sha>`; `scripts/release.sh`
 * captures it and re-verifies it immediately before creating the git tag.
 */
import { readFileSync } from "node:fs";
import { evaluateCompletionGate } from "../packages/shared/src/veera/completion-gate.js";
import { evaluateReleaseGate } from "../packages/shared/src/veera/release-gate.js";
import type {
  AuthoritativeBindings,
  PublisherAttestation,
} from "../packages/shared/src/veera/types.js";

function arg(name: string): string | undefined {
  const ix = process.argv.indexOf(name);
  return ix === -1 ? undefined : process.argv[ix + 1];
}

function failUsage(message: string): never {
  console.error(`veera-gate: ${message}`);
  process.exit(2);
}

const mode = arg("--mode");
if (mode !== "release" && mode !== "completion") {
  failUsage("--mode must be release or completion");
}

const contractPath = arg("--contract");
const auditPath = arg("--audit");
const bindingsPath = arg("--bindings");
if (!contractPath || !auditPath || !bindingsPath) {
  failUsage("--contract, --audit and --bindings paths are required");
}

const publisherId = arg("--publisher-id") ?? "";
const publisherAuthenticated = arg("--publisher-authenticated") === "1";
const publisher: PublisherAttestation = {
  publisherId,
  authenticated: publisherAuthenticated,
};

let contractBytes: string;
let auditText: string;
let bindings: AuthoritativeBindings;
try {
  contractBytes = readFileSync(contractPath, "utf-8");
  auditText = readFileSync(auditPath, "utf-8");
  bindings = JSON.parse(readFileSync(bindingsPath, "utf-8")) as AuthoritativeBindings;
} catch (err) {
  failUsage(`cannot read gate inputs: ${(err as Error).message}`);
}

if (mode === "release") {
  const actualSha = arg("--actual-sha") ?? "";
  const pinnedSha = arg("--pinned") ?? "";
  const releaseKind = arg("--release-kind") ?? "scoped";
  if (releaseKind !== "scoped" && releaseKind !== "intermediate") {
    failUsage("--release-kind must be scoped or intermediate");
  }
  const postReqIds = (arg("--post-req-ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const result = evaluateReleaseGate({
    contractBytes,
    auditText,
    publisher,
    bindings,
    actualHeadSha: actualSha,
    pinnedCandidateSha: pinnedSha,
    deployArtifactSha: arg("--deploy-sha"),
    releaseRepo: arg("--release-repo"),
    releaseKind,
    postDeploymentRequirementIds: postReqIds,
  });
  for (const n of result.notes) console.log(`veera-gate note: ${n}`);
  for (const b of result.blocks) {
    console.log(`veera-gate block [${b.case ?? "-"}:${b.code}]: ${b.message}`);
  }
  if (result.verdict === "PASS") {
    console.log(`veera-gate verdict: PASS gatedSha=${result.gatedSha}`);
    console.log(`VEERA_GATED_SHA=${result.gatedSha}`);
    process.exit(0);
  }
  if (result.verdict === "NOT_APPLICABLE") {
    console.log("veera-gate verdict: NOT_APPLICABLE (intermediate; existing gates apply)");
    process.exit(0);
  }
  console.log("veera-gate verdict: HOLD (release blocked)");
  process.exit(1);
} else {
  const parentDeliveryId = arg("--parent-delivery") ?? "";
  const deployedSha = arg("--deployed") ?? "";
  const pinnedSha = arg("--pinned") ?? "";
  if (!parentDeliveryId || !deployedSha || !pinnedSha) {
    failUsage("completion mode requires --parent-delivery, --deployed and --pinned");
  }
  const result = evaluateCompletionGate({
    contractBytes,
    auditText,
    publisher,
    bindings,
    parentDeliveryId,
    deployedSha,
    pinnedCandidateSha: pinnedSha,
  });
  for (const n of result.notes) console.log(`veera-gate note: ${n}`);
  for (const b of result.blocks) {
    console.log(`veera-gate block [${b.case ?? "-"}:${b.code}]: ${b.message}`);
  }
  if (result.verdict === "PASS") {
    console.log("veera-gate verdict: PASS (parent completion authorized)");
    process.exit(0);
  }
  console.log("veera-gate verdict: HOLD (completion blocked)");
  process.exit(1);
}
