# Active Checkout Locks: Operators, Denials, and Release Paths

Status: Current implementation guide (verified by tests)
Date: 2026-10-02
Audience: Operators, on-call responders, and agents handling a locked task

This document records the verified truth about agent checkout locks on issues:
what the lock is, who can act on a locked issue, what the lock denial tells an
operator, and which release paths exist. Every claim here is exercised by the
integration tests listed in §7 — if the code and this document disagree, fix the
code or fix the document, never silently.

## 1. The lock model

An issue is checkout-locked when all of the following hold:

- `status` is `in_progress`,
- `assigneeAgentId` names an agent, and
- `checkoutRunId` names the heartbeat run holding the lock.

Checkout and run ownership stay assignee-scoped even though issue writes are
default-open for standard-trust agents. A *live* holder run clears the lock on
its own when the run finishes and releases the issue. A *dead* holder run (one
that reached a terminal status — `succeeded`, `interrupted`, `failed`,
`cancelled`, `timed_out` — or whose row is gone) can never release its own
lock; such a lock stays until a sanctioned release runs.

## 2. Who can act on a locked issue (verified)

| Actor | Field edit (`PATCH /api/issues/:id`) | Release lock (`POST /api/issues/:id/release`) | Force-release (`POST /api/issues/:id/admin/force-release`) |
| --- | --- | --- | --- |
| Assignee agent, holding live run | allowed | allowed (the run owns the lock) | 403 — board only |
| Assignee agent, new run, holder run dead | allowed (adopts the stale lock) | allowed (releases the stale lock) | 403 — board only |
| Peer agent, no grant | 409 run-lock denial | 409 run-lock denial (route gate) | 403 — board only |
| Peer agent with `tasks:manage_active_checkouts` | **allowed** (override) | 409 — `Only assignee can release issue` | 403 — board only |
| Board member | allowed | allowed (no agent guard applies) | allowed |

The table covers field edits. Status transitions carry additional
per-transition guards (review verdicts, follow-up ownership, restore rules)
that are outside this document's scope.

Who holds `tasks:manage_active_checkouts`: company CEOs by role, the assignee's
manager (reporting chain), and agents with an explicit principal grant. The
permission deliberately does not ride on the default `canCreateAgents` flag —
see `server/src/services/authorization.ts`.

**Known gap (flagged, not fixed):** the `tasks:manage_active_checkouts`
override widens *mutation* of a locked issue but not *lock release*. The
release service rejects every non-assignee agent actor, so a grant holder can
edit a dead-locked issue but cannot clear the lock — only the assignee's next
run or a board member can. Until this is redesigned, route dead-lock recovery
through the assignee or a board member.

## 3. Reading a lock denial

A peer whose write to a locked issue is refused gets a `409` with
`details.code = "issue_write_assignee_run_lock"`. The copy contract lives in
`packages/shared/src/issue-write-denial.ts`; the API `error` string and the
board UI notice render the same words.

**Live holder run** (the lock will clear on its own):

- boundary: `Run checkout lock`
- the copy says a run is live and routes the peer to comments (which stay open
  and wake the assignee) or to waiting for the run to finish.

**Dead holder run:**

- boundary: `Stale run checkout lock`
- names who holds the lock (assignee label + `checkoutRunId`), the terminal
  status and the time it was reached when the run row provides them (plain
  "no longer exists" when it does not), and states that the lock will not clear
  on its own
- the sanctioned path names both release routes: `POST /issues/:id/release`
  from the assignee's next run (the new run adopts and clears the stale lock)
  and `POST /issues/:id/admin/force-release` for a board member.

Machine-readable holder context rides in `details` on both the live and dead
variants: `issueId`, `assigneeAgentId`, `actorAgentId`, `checkoutRunId`, and —
only when the holder run is known dead — `checkoutRunDead: true`,
`checkoutRunStatus`, and `checkoutRunDeadSince` (ISO timestamp, absent when not
determinable).

## 4. Release paths in detail

### Assignee, live run

```
POST /api/issues/:id/release
```

The assignee's own run releases the lock; `in_progress` work is requeued to
`todo` and assignment is relinquished (terminal statuses keep their assignee
attribution).

### Assignee, dead holder run

Same call from any later run of the assignee. The service detects the holder
run is terminal and lets the new run adopt and clear the stale lock instead of
rejecting with `Only checkout run can release issue`.

### Board member

```
POST /api/issues/:id/release                      # requeues in_progress work
POST /api/issues/:id/admin/force-release          # clears run locks, keeps status/assignee
POST /api/issues/:id/admin/force-release?clearAssignee=true
```

Board actors skip the agent assignee guard entirely, so both routes work. The
force-release route is the only one that clears `checkoutRunId`/
`executionRunId` while leaving issue status and (by default) the assignee in
place, and it writes an `issue.admin_force_release` audit event.

### Peer agent with the management grant

No lock-release path today (see the flagged gap in §2). The grant holder can
edit the locked issue's fields directly, which is often enough to unblock a
stuck task without touching the lock.

## 5. Auto-release

A scheduled checkout-lock sweeper reclaims locks whose holder run has reached a
terminal state, so dead-run locks are expected to clear automatically once the
sweeper is enabled on an instance. The manual paths in §4 remain the sanctioned
escalation when the sweeper is not running or has not yet fired.

## 6. Denial copy extension points

The copy contract is additive: `IssueWriteDenialContext` grew
`checkoutRunId`, `checkoutRunDead`, `checkoutRunStatus`, and
`checkoutRunDeadSince`. Callers that do not supply them render exactly the
pre-existing live-run copy, so UI and API stay compatible. The server resolves
holder-run liveness in `server/src/routes/issues.ts`
(`describeCheckoutRunLockForDenial`) and degrades to live-semantics copy if the
lookup fails.

## 7. Verification

Claims in this document are pinned by:

- `packages/shared/src/issue-write-denial.test.ts` — copy contract: live copy
  unchanged, dead copy names holder/run id/death evidence/release routes.
- `server/src/__tests__/issue-dead-run-lock-denial-routes.test.ts` — end-to-end
  route behavior on a real database: dead-run denial payload, live-run denial
  unchanged, grant-holder edit-succeeds/release-fails, peer denial at the
  release gate, board edit + force-release + plain release.
- `server/src/__tests__/issue-stale-execution-lock-routes.test.ts` — assignee
  stale-lock adoption and release, board-only force-release guard.

Run them with:

```
pnpm --filter @paperclipai/shared test -- issue-write-denial
pnpm --filter @paperclipai/server test -- issue-dead-run-lock-denial-routes
pnpm --filter @paperclipai/server test -- issue-stale-execution-lock-routes
```
