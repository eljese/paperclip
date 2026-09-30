# Veera T4 — release + parent-completion integration (JES-149)

How the deterministic validator (T2) is wired into the actual release and
parent-delivery completion paths. A prompt saying "refuse release" is not
enforcement; the entry points below reject.

## 1. Release path (pre-deployment)

**Real command:** `scripts/release.sh`.

- When `VEERA_DELIVERY_ID` is set (the release carries a Veera-scoped
  delivery's committed scope), `release.sh` runs `node
  scripts/veera-gate.mjs --mode release` BEFORE any build or publish.
  Any non-zero gate exit blocks the release (`release_fail`).
- The wrapper resolves the actually-observed HEAD via `git rev-parse HEAD`
  **at gate time** (pinned-SHA re-check, AC-14) and evaluates the real
  `evaluateReleaseGate` entry point (`packages/shared/src/veera/release-gate.ts`)
  through the workspace-pinned tsx runtime — never a copy.
- On PASS the gate prints `VEERA_GATED_SHA=<sha>`; `release.sh` captures it
  and **re-verifies immediately before `git tag`** that HEAD and the planned
  source commit still equal the gated SHA. A branch that moved after the gate
  (squash/merge/rebase = new SHA) blocks tagging; fresh approval is required.
- `VEERA_DELIVERY_ID` unset = no scoped delivery = existing flow unchanged
  (canary/nightly/beta/stable behave exactly as before). Scoped gating is
  opt-in per delivery, so existing merge/review policy is preserved and no
  unrelated release is newly blocked.
- `VEERA_RELEASE_KIND=intermediate` (a release that does NOT carry the
  committed scope) returns `NOT_APPLICABLE`: existing technical gates apply,
  and the verdict is never a Veera approval — scoped release and parent
  completion stay blocked (AC-11).

**Required env when gated:** `VEERA_CONTRACT_PATH`, `VEERA_AUDIT_PATH`,
`VEERA_BINDINGS_PATH` (authoritative delivery-record files),
`VEERA_PINNED_SHA`, `VEERA_PUBLISHER_ID`, plus
`VEERA_PUBLISHER_AUTHENTICATED=1`. Optional: `VEERA_CANDIDATE_REPO_DIR`
(default: repo root), `VEERA_RELEASE_KIND`, `VEERA_RELEASE_REPO`,
`VEERA_DEPLOY_SHA` (default: observed HEAD), `VEERA_POST_REQ_IDS`.

## 2. Parent-completion path (controlled close)

**Real operation:** `evaluateCompletionGate`
(`packages/shared/src/veera/completion-gate.ts`), run as
`node scripts/veera-gate.mjs --mode completion --parent-delivery <id>
--deployed <sha> [--pinned <sha>]` with the same contract/audit/bindings
inputs. The delivery owner (Ahti-CTO) must obtain a PASS verdict BEFORE
closing the parent delivery issue (`PATCH /api/issues/{id}` → `done`).

- Completion requires a FULL final PASS with no partition: post-deployment
  requirements must be PASS with evidence bound to the DEPLOYED artifact.
  Pending production-only checks HOLD completion while having allowed
  deployment (`deploymentOnly` release verdict, AC-11).
- Only the pinned candidate's deployment counts: `deployedSha` must equal the
  approved pinned SHA and the authoritative binding (AC-14).
- Contract-only change invalidates old approval; plan change invalidates plan
  approval (AC-07) — enforced through the validator bindings, tested through
  these gates.

## 3. Permissions

| Step | Who | How |
|---|---|---|
| Set gate env + run `release.sh` | Vaka-Release (release authority) / engineer merging | Existing release authority; gate inputs from the authoritative delivery record |
| Trusted publisher attestation (`VEERA_PUBLISHER_ID` + `..._AUTHENTICATED=1`) | Protected publisher / CI identity only | Until the board names the trusted publisher (T1 blocker B3), the allowlist stays empty for real deliveries and the gate FAILS CLOSED (case 7) |
| Scope amendments | Ukko within delegated authority, else Jesse (`local-board`) | Authenticated issue thread + `request_board_approval`; bare `approved_by` strings rejected (case 6) |
| Run completion gate + close parent | Ahti-CTO (delivery close owner) | PASS verdict required first (controlled procedure) |
| Correction budget | Ahti-CTO ledger (attempt-zero + max 2 automatic; 3rd via Jesse/Ukko) | Shared delivery-level budget; exhaustion escalates, never flips HOLD to PASS |

## 4. Remaining administrator bypass (accurately reported)

Enforcement is real at the wired entry points, but these bypasses remain and
are NOT prevented by this task:

1. **Direct `npm publish` / manual `git tag` bypassing `release.sh`.**
   The gate lives in the release script, not in npm or git itself.
2. **Paperclip issue-close API without running the completion gate.**
   The completion adapter cannot hard-block `PATCH /api/issues/{id}`; the
   controlled procedure requires a PASS first, but a direct API close with
   sufficient permissions still lands. Treat un-gated closes as procedure
   violations, detectable via the missing gate verdict in the thread.
3. **Evidence forgery outside the trusted path.** The validator rejects
   non-publisher audits (case 7) and unbound evidence (case 4) — but only
   because bindings + publisher attestation come from the protected delivery
   record. If an attacker controls the bindings file or the
   `VEERA_PUBLISHER_AUTHENTICATED` env, the gate sees forged authority.
   In production these MUST be injected by the protected CI context, never
   hand-set by the release requester.
4. **Fork `master` unprotected + 0 check-runs on fork PRs** (T1 findings
   F1/F2): Rehti/QA gate inputs for fork candidates currently have no
   required-check set to verify against. Until the board resolves B1/B3 and
   required checks exist, treat fork releases as gated on Veera evidence
   only, and record which technical gates were actually verified.

## 5. Operator quick reference

```bash
# Scoped release (Vaka-Release / merging engineer):
export VEERA_DELIVERY_ID=JES-000 VEERA_PINNED_SHA=<40-char sha>
export VEERA_CONTRACT_PATH=./contract.json VEERA_AUDIT_PATH=./audit.json
export VEERA_BINDINGS_PATH=./bindings.json VEERA_PUBLISHER_ID=<trusted id>
export VEERA_PUBLISHER_AUTHENTICATED=1   # protected CI context only
./scripts/release.sh canary              # gate runs pre-deployment

# Parent completion (Ahti-CTO), after deployment:
node scripts/veera-gate.mjs --mode completion \
  --contract ./contract.json --audit ./audit-final.json \
  --bindings ./bindings.json --pinned <sha> \
  --parent-delivery JES-000 --deployed <sha> \
  --publisher-id <trusted id> --publisher-authenticated 1
# exit 0 = close authorized; exit 1 = HOLD (blocked); exit 2 = config error
```
