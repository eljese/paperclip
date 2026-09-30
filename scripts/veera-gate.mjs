#!/usr/bin/env node
/**
 * Veera T4 — real release/completion gate command (JES-149, PRD section 8).
 *
 * Invoked by `scripts/release.sh` (pre-deployment, when VEERA_DELIVERY_ID is
 * set) and by the controlled parent-completion procedure. Resolves the
 * actually-observed HEAD SHA from git IMMEDIATELY before evaluation
 * (pinned-SHA re-check, AC-14) and delegates the verdict to
 * `veera-gate.impl.ts` (the real `evaluateReleaseGate` /
 * `evaluateCompletionGate` entry points) via the workspace tsx runtime.
 *
 * Fail-closed: any usage/config error, missing tsx runtime, git resolution
 * failure, or missing evidence files exits non-zero and blocks the caller.
 * Exit codes: 0 = PASS (or intermediate NOT_APPLICABLE), 1 = HOLD/blocked,
 * 2 = usage/config error.
 *
 * Env (CLI flags of the same lowercase-dashed name win, e.g. --pinned):
 *   VEERA_MODE=release|completion            (required unless --mode given)
 *   VEERA_CONTRACT_PATH / VEERA_AUDIT_PATH / VEERA_BINDINGS_PATH
 *   VEERA_PINNED_SHA                          approved pinned candidate SHA
 *   VEERA_PUBLISHER_ID                        trusted publisher identity
 *   VEERA_PUBLISHER_AUTHENTICATED=1           set ONLY by the protected
 *                                             publisher/CI context; anything
 *                                             else fails closed (case 7)
 *   VEERA_CANDIDATE_REPO_DIR                  git checkout to re-check
 *                                             (release mode; default: repo root)
 *   VEERA_RELEASE_KIND=scoped|intermediate    (release mode; default scoped)
 *   VEERA_RELEASE_REPO                        expected repo identity
 *   VEERA_DEPLOY_SHA                          deploy artifact (default: HEAD)
 *   VEERA_POST_REQ_IDS                        comma-separated post-deploy IDs
 *   VEERA_PARENT_DELIVERY / VEERA_DEPLOYED_SHA (completion mode)
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(HERE);

function cliArg(name) {
  const ix = process.argv.indexOf(name);
  return ix === -1 ? undefined : process.argv[ix + 1];
}

function env(name) {
  const v = process.env[name];
  return v === undefined || v.length === 0 ? undefined : v;
}

function die(message) {
  console.error(`veera-gate: ${message}`);
  process.exit(2);
}

function passthrough(name, value) {
  return value === undefined ? [] : [name, value];
}

const mode = cliArg("--mode") ?? env("VEERA_MODE");
if (mode !== "release" && mode !== "completion") {
  die("--mode release|completion is required (or VEERA_MODE)");
}

// The gate only runs TypeScript through the workspace-pinned tsx runtime so
// the evaluated code is exactly the reviewed veera module — never a copy.
const tsxCandidates = [
  join(REPO_ROOT, "cli", "node_modules", "tsx", "dist", "cli.mjs"),
  join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
];
const tsx = tsxCandidates.find((p) => existsSync(p));
if (!tsx) {
  die("tsx runtime not found in workspace; refusing to evaluate the gate on a copy (fail closed)");
}

const impl = join(REPO_ROOT, "scripts", "veera-gate.impl.ts");
if (!existsSync(impl)) die("veera-gate.impl.ts is missing");

const contractPath = cliArg("--contract") ?? env("VEERA_CONTRACT_PATH");
const auditPath = cliArg("--audit") ?? env("VEERA_AUDIT_PATH");
const bindingsPath = cliArg("--bindings") ?? env("VEERA_BINDINGS_PATH");
if (!contractPath || !auditPath || !bindingsPath) {
  die("--contract, --audit and --bindings are required (or VEERA_*_PATH)");
}
for (const [label, p] of [
  ["contract", contractPath],
  ["audit", auditPath],
  ["bindings", bindingsPath],
]) {
  if (!existsSync(p)) die(`${label} file not found at ${p} (fail closed)`);
}

const args = [
  tsx,
  impl,
  "--mode",
  mode,
  "--contract",
  contractPath,
  "--audit",
  auditPath,
  "--bindings",
  bindingsPath,
  ...passthrough("--publisher-id", cliArg("--publisher-id") ?? env("VEERA_PUBLISHER_ID") ?? ""),
  ...passthrough(
    "--publisher-authenticated",
    cliArg("--publisher-authenticated") ?? env("VEERA_PUBLISHER_AUTHENTICATED") ?? "0",
  ),
  ...passthrough("--pinned", cliArg("--pinned") ?? env("VEERA_PINNED_SHA") ?? ""),
];

if (mode === "release") {
  // Pinned-SHA re-check: resolve the actually-observed HEAD from git right
  // here, immediately before evaluation. A moved branch blocks (AC-14).
  const repoDir = cliArg("--repo-dir") ?? env("VEERA_CANDIDATE_REPO_DIR") ?? REPO_ROOT;
  let actualSha;
  try {
    actualSha =
      cliArg("--actual-sha") ??
      execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
  } catch {
    die(`cannot resolve HEAD in ${repoDir} (fail closed)`);
  }
  args.push(
    "--actual-sha",
    actualSha,
    ...passthrough(
      "--release-kind",
      cliArg("--release-kind") ?? env("VEERA_RELEASE_KIND") ?? "scoped",
    ),
    ...passthrough("--release-repo", cliArg("--release-repo") ?? env("VEERA_RELEASE_REPO")),
    ...passthrough(
      "--deploy-sha",
      cliArg("--deploy-sha") ?? env("VEERA_DEPLOY_SHA") ?? actualSha,
    ),
    ...passthrough("--post-req-ids", cliArg("--post-req-ids") ?? env("VEERA_POST_REQ_IDS")),
  );
} else {
  const parentDelivery = cliArg("--parent-delivery") ?? env("VEERA_PARENT_DELIVERY");
  const deployed = cliArg("--deployed") ?? env("VEERA_DEPLOYED_SHA");
  if (!parentDelivery || !deployed) {
    die("completion mode requires --parent-delivery and --deployed (or VEERA_PARENT_DELIVERY / VEERA_DEPLOYED_SHA)");
  }
  args.push("--parent-delivery", parentDelivery, "--deployed", deployed);
}

const child = spawnSync(process.execPath, args, { stdio: "inherit" });
if (child.error) die(`failed to run gate runtime: ${child.error.message}`);
process.exit(child.status ?? 2);
