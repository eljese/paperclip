import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRelations,
  issues,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import {
  classifyCheckoutLockForSweep,
  sweepStaleCheckoutLocks,
} from "./checkout-lock-sweeper.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping checkout-lock sweeper tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// Thirty-minute dead-age gate; stale fixtures sit two hours in the past,
// fresh fixtures one minute in the past.
const DEAD_MS = 30 * 60 * 1000;
const STALE_AT = () => new Date(Date.now() - 2 * 60 * 60 * 1000);
const FRESH_AT = () => new Date(Date.now() - 60 * 1000);
// 2^30 is not a live pid on any supported host, so the real isPidAlive probe
// reports it dead without any injection.
const DEAD_PID = 2 ** 30;

describeEmbeddedPostgres("checkout-lock sweeper", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-checkout-lock-sweep-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(issueRelations);
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyAgent() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Coder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedRun(input: {
    companyId: string;
    agentId: string;
    status: string;
    finishedAt?: Date | null;
    updatedAt?: Date | null;
    processPid?: number | null;
    processGroupId?: number | null;
    controllerLeaseExpiresAt?: Date | null;
  }) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      companyId: input.companyId,
      agentId: input.agentId,
      status: input.status,
      invocationSource: "manual",
      startedAt: STALE_AT(),
      finishedAt: input.finishedAt ?? null,
      updatedAt: input.updatedAt ?? new Date(),
      processPid: input.processPid ?? null,
      processGroupId: input.processGroupId ?? null,
      controllerLeaseExpiresAt: input.controllerLeaseExpiresAt ?? null,
    });
    return id;
  }

  async function seedLockedIssue(input: {
    companyId: string;
    agentId: string;
    runId: string;
    status?: string;
  }) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId: input.companyId,
      title: "Checkout-locked issue",
      status: input.status ?? "in_progress",
      priority: "high",
      assigneeAgentId: input.agentId,
      checkoutRunId: input.runId,
      executionRunId: input.runId,
      executionLockedAt: STALE_AT(),
    });
    return id;
  }

  async function readLock(issueId: string) {
    return db
      .select({
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        executionAgentNameKey: issues.executionAgentNameKey,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
  }

  async function readSweepActivities() {
    return db
      .select({ action: activityLog.action, details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.checkout_lock_swept"));
  }

  it("releases a stale terminal-run lock with no API access to the issue", async () => {
    const { companyId, agentId } = await seedCompanyAgent();
    const runId = await seedRun({
      companyId,
      agentId,
      status: "failed",
      finishedAt: STALE_AT(),
      updatedAt: STALE_AT(),
    });
    const issueId = await seedLockedIssue({ companyId, agentId, runId });

    const result = await sweepStaleCheckoutLocks(db, { deadMs: DEAD_MS });

    expect(result.swept).toBe(1);
    expect(result.issueIds).toEqual([issueId]);
    const lock = await readLock(issueId);
    expect(lock?.checkoutRunId).toBeNull();
    expect(lock?.executionRunId).toBeNull();
    expect(lock?.executionAgentNameKey).toBeNull();
    expect(lock?.executionLockedAt).toBeNull();
    // The sweep releases the lock only: status and assignee are untouched.
    expect(lock?.status).toBe("in_progress");
    expect(lock?.assigneeAgentId).toBe(agentId);

    const activities = await readSweepActivities();
    expect(activities).toHaveLength(1);
    const details = activities[0]?.details as Record<string, unknown> | null;
    expect(details?.runId).toBe(runId);
    expect(details?.reason).toBe("terminal_row");
    expect(typeof details?.deadAgeMs).toBe("number");
    expect(details?.deadAgeMs as number).toBeGreaterThan(DEAD_MS);
  });

  it("releases a non-terminal lock whose registered process is dead", async () => {
    const { companyId, agentId } = await seedCompanyAgent();
    const runId = await seedRun({
      companyId,
      agentId,
      status: "running",
      updatedAt: STALE_AT(),
      processPid: DEAD_PID,
    });
    const issueId = await seedLockedIssue({ companyId, agentId, runId });

    const result = await sweepStaleCheckoutLocks(db, { deadMs: DEAD_MS });

    expect(result.swept).toBe(1);
    expect((await readLock(issueId))?.checkoutRunId).toBeNull();
    const activities = await readSweepActivities();
    expect(activities).toHaveLength(1);
    expect((activities[0]?.details as Record<string, unknown> | null)?.reason).toBe(
      "dead_process",
    );
  });

  it("leaves a live-process lock alone even when the row is old", async () => {
    const { companyId, agentId } = await seedCompanyAgent();
    const runId = await seedRun({
      companyId,
      agentId,
      status: "running",
      updatedAt: STALE_AT(),
      // The test process itself: the real isPidAlive probe reports it live.
      processPid: process.pid,
    });
    const issueId = await seedLockedIssue({ companyId, agentId, runId });

    const result = await sweepStaleCheckoutLocks(db, { deadMs: DEAD_MS });

    expect(result.swept).toBe(0);
    expect((await readLock(issueId))?.checkoutRunId).toBe(runId);
    expect(await readSweepActivities()).toHaveLength(0);
  });

  it("leaves a fresh terminal lock alone until it ages past the gate", async () => {
    const { companyId, agentId } = await seedCompanyAgent();
    const runId = await seedRun({
      companyId,
      agentId,
      status: "failed",
      finishedAt: FRESH_AT(),
      updatedAt: FRESH_AT(),
    });
    const issueId = await seedLockedIssue({ companyId, agentId, runId });

    const result = await sweepStaleCheckoutLocks(db, { deadMs: DEAD_MS });

    expect(result.swept).toBe(0);
    expect((await readLock(issueId))?.checkoutRunId).toBe(runId);
  });

  it("skips locks with uncertain liveness instead of risking a double run", async () => {
    const { companyId, agentId } = await seedCompanyAgent();
    const noMetadataRunId = await seedRun({
      companyId,
      agentId,
      status: "running",
      updatedAt: STALE_AT(),
    });
    const leasedRunId = await seedRun({
      companyId,
      agentId,
      status: "running",
      updatedAt: STALE_AT(),
      processPid: DEAD_PID,
      controllerLeaseExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    const handledRunId = await seedRun({
      companyId,
      agentId,
      status: "running",
      updatedAt: STALE_AT(),
      processPid: DEAD_PID,
    });
    const noMetadataIssue = await seedLockedIssue({ companyId, agentId, runId: noMetadataRunId });
    const leasedIssue = await seedLockedIssue({ companyId, agentId, runId: leasedRunId });
    const handledIssue = await seedLockedIssue({ companyId, agentId, runId: handledRunId });

    const result = await sweepStaleCheckoutLocks(db, {
      deadMs: DEAD_MS,
      // A live in-memory handle on this host owns the run even though the
      // recorded pid is dead.
      hasLiveHandle: (runId) => runId === handledRunId,
    });

    expect(result.swept).toBe(0);
    for (const issueId of [noMetadataIssue, leasedIssue, handledIssue]) {
      expect((await readLock(issueId))?.checkoutRunId).not.toBeNull();
    }
    expect(await readSweepActivities()).toHaveLength(0);
  });

  it("is idempotent across repeated sweeps", async () => {
    const { companyId, agentId } = await seedCompanyAgent();
    const runId = await seedRun({
      companyId,
      agentId,
      status: "failed",
      finishedAt: STALE_AT(),
      updatedAt: STALE_AT(),
    });
    await seedLockedIssue({ companyId, agentId, runId });

    const first = await sweepStaleCheckoutLocks(db, { deadMs: DEAD_MS });
    const second = await sweepStaleCheckoutLocks(db, { deadMs: DEAD_MS });

    expect(first.swept).toBe(1);
    expect(second.swept).toBe(0);
    expect(second.issueIds).toEqual([]);
    expect(await readSweepActivities()).toHaveLength(1);
  });

  it("racing a concurrent release leaves the released issue consistent", async () => {
    const { companyId, agentId } = await seedCompanyAgent();
    const runId = await seedRun({
      companyId,
      agentId,
      status: "failed",
      finishedAt: STALE_AT(),
      updatedAt: STALE_AT(),
    });
    const issueId = await seedLockedIssue({ companyId, agentId, runId });

    const result = await sweepStaleCheckoutLocks(db, {
      deadMs: DEAD_MS,
      hooks: {
        // A concurrent releaser clears the lock after the sweep read it.
        // The sweep's compare-and-swap must then affect zero rows.
        beforeRelease: async () => {
          await db
            .update(issues)
            .set({
              checkoutRunId: null,
              executionRunId: null,
              executionAgentNameKey: null,
              executionLockedAt: null,
              updatedAt: new Date(),
            })
            .where(eq(issues.id, issueId));
        },
      },
    });

    expect(result.swept).toBe(0);
    const lock = await readLock(issueId);
    expect(lock?.checkoutRunId).toBeNull();
    expect(lock?.status).toBe("in_progress");
    expect(await readSweepActivities()).toHaveLength(0);
  });

  it("a run finishing inside the sweep window keeps its lock", async () => {
    const { companyId, agentId } = await seedCompanyAgent();
    const runId = await seedRun({
      companyId,
      agentId,
      status: "running",
      updatedAt: STALE_AT(),
      processPid: DEAD_PID,
    });
    const issueId = await seedLockedIssue({ companyId, agentId, runId });

    const result = await sweepStaleCheckoutLocks(db, {
      deadMs: DEAD_MS,
      hooks: {
        // The holding run reaches a terminal status just now, after the
        // sweep's first read. Its fresh terminal timestamp is below the
        // dead-age gate, so the transactional re-evaluation must keep it.
        beforeRelease: async () => {
          await db
            .update(heartbeatRuns)
            .set({ status: "succeeded", finishedAt: new Date(), updatedAt: new Date() })
            .where(eq(heartbeatRuns.id, runId));
        },
      },
    });

    expect(result.swept).toBe(0);
    expect((await readLock(issueId))?.checkoutRunId).toBe(runId);
    expect(await readSweepActivities()).toHaveLength(0);
  });
});

describe("classifyCheckoutLockForSweep", () => {
  const probes = {
    isPidAlive: () => false,
    isProcessGroupAlive: () => false,
    hasLiveHandle: () => false,
  };
  const issue = {
    id: "issue-1",
    companyId: "company-1",
    status: "in_progress",
    checkoutRunId: "run-1",
    executionRunId: "run-1",
    executionLockedAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-06-01T00:00:00Z"),
  };

  it("treats a missing run row as a terminal row aged on the issue lock", () => {
    const verdict = classifyCheckoutLockForSweep({
      issue,
      run: null,
      nowMs: new Date("2026-10-02T00:00:00Z").getTime(),
      deadMs: DEAD_MS,
      probes,
    });
    expect(verdict.sweepable).toBe(true);
    if (verdict.sweepable) {
      expect(verdict.reason).toBe("terminal_row");
      expect(verdict.runId).toBe("run-1");
    }
  });

  it("refuses non-in_progress issues", () => {
    const verdict = classifyCheckoutLockForSweep({
      issue: { ...issue, status: "todo" },
      run: null,
      nowMs: Date.now(),
      deadMs: 0,
      probes,
    });
    expect(verdict).toEqual({ sweepable: false, skipReason: "not_in_progress" });
  });
});
