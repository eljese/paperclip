import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { issueRoutes } from "../routes/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres dead-run lock denial route tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

// Verification suite for the dead-run checkout-lock denial copy and the
// operator release path (who can act on a locked issue, and exactly what a
// `tasks:manage_active_checkouts` holder can and cannot do). The assertions
// here are the source of truth for doc/active-checkouts.md.
describeEmbeddedPostgres("dead-run checkout lock denial routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-dead-run-lock-denial-routes-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function createApp(actor: Express.Request["actor"]) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = actor;
      next();
    });
    app.use("/api", issueRoutes(db, {} as any));
    app.use(errorHandler);
    return app;
  }

  /**
   * Seeds a company, the issue-owning agent (with one dead and one live run),
   * a plain peer agent, and a peer agent holding the active-checkout
   * management override (CEO role grants `tasks:manage_active_checkouts`).
   */
  async function seedDeadRunLock() {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const peerAgentId = randomUUID();
    const grantAgentId = randomUUID();
    const deadRunId = randomUUID();
    const liveRunId = randomUUID();
    const peerRunId = randomUUID();
    const grantRunId = randomUUID();
    const deadSince = new Date("2026-10-01T12:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: peerAgentId,
        companyId,
        name: "PeerAgent",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: grantAgentId,
        companyId,
        name: "CheckoutManager",
        role: "ceo",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(heartbeatRuns).values([
      {
        id: deadRunId,
        companyId,
        agentId: ownerAgentId,
        status: "failed",
        invocationSource: "manual",
        finishedAt: deadSince,
      },
      {
        id: liveRunId,
        companyId,
        agentId: ownerAgentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date(),
      },
      {
        id: peerRunId,
        companyId,
        agentId: peerAgentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date(),
      },
      {
        id: grantRunId,
        companyId,
        agentId: grantAgentId,
        status: "running",
        invocationSource: "manual",
        startedAt: new Date(),
      },
    ]);

    return { companyId, ownerAgentId, peerAgentId, grantAgentId, deadRunId, liveRunId, peerRunId, grantRunId, deadSince };
  }

  async function seedLockedIssue(companyId: string, ownerAgentId: string, checkoutRunId: string) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Dead-run locked task",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: ownerAgentId,
      checkoutRunId,
      executionRunId: checkoutRunId,
      executionAgentNameKey: "codexcoder",
      executionLockedAt: new Date(),
    });
    return issueId;
  }

  /** Actor runs must carry the target issue as their source to stay in-scope. */
  async function bindRunsToIssue(runIds: string[], issueId: string) {
    for (const runId of runIds) {
      await db
        .update(heartbeatRuns)
        .set({ contextSnapshot: { issueId } })
        .where(eq(heartbeatRuns.id, runId));
    }
  }

  function agentActor(companyId: string, agentId: string, runId: string): Express.Request["actor"] {
    return {
      type: "agent",
      agentId,
      companyId,
      runId,
      source: "agent_jwt",
    };
  }

  function boardActor(companyId: string): Express.Request["actor"] {
    return {
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      memberships: [{ companyId, membershipRole: "admin", status: "active" }],
      isInstanceAdmin: false,
      source: "session",
    };
  }

  async function loadIssue(issueId: string) {
    return db
      .select({
        title: issues.title,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]);
  }

  it("names the dead holder run and the sanctioned release path on the first rejected patch", async () => {
    const seed = await seedDeadRunLock();
    const issueId = await seedLockedIssue(seed.companyId, seed.ownerAgentId, seed.deadRunId);
    await bindRunsToIssue([seed.peerRunId, seed.grantRunId], issueId);

    const res = await request(createApp(agentActor(seed.companyId, seed.peerAgentId, seed.peerRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Peer edit over a dead lock" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details.code).toBe("issue_write_assignee_run_lock");
    expect(res.body.details.boundary).toBe("Stale run checkout lock");
    // (a) who holds it
    expect(res.body.error).toContain("CodexCoder");
    expect(res.body.error).toContain(seed.deadRunId);
    // (b) dead and since when
    expect(res.body.error.toLowerCase()).toContain("dead");
    expect(res.body.error).toContain('"failed"');
    expect(res.body.error).toContain(seed.deadSince.toISOString());
    // (c) the exact sanctioned release path
    expect(res.body.error).toContain("POST /issues/:id/release");
    expect(res.body.error).toContain("POST /issues/:id/admin/force-release");
    // machine-readable holder context rides the details payload
    expect(res.body.details.checkoutRunId).toBe(seed.deadRunId);
    expect(res.body.details.checkoutRunDead).toBe(true);
    expect(res.body.details.checkoutRunStatus).toBe("failed");
    expect(res.body.details.checkoutRunDeadSince).toBe(seed.deadSince.toISOString());
    expect(res.body.details.assigneeAgentId).toBe(seed.ownerAgentId);

    // The denial is read-only: the lock and the issue are untouched.
    expect(await loadIssue(issueId)).toEqual({
      title: "Dead-run locked task",
      status: "in_progress",
      assigneeAgentId: seed.ownerAgentId,
      checkoutRunId: seed.deadRunId,
    });
  });

  it("keeps the live-run lock denial on today's copy with no dead claim", async () => {
    const seed = await seedDeadRunLock();
    const issueId = await seedLockedIssue(seed.companyId, seed.ownerAgentId, seed.liveRunId);
    await bindRunsToIssue([seed.peerRunId], issueId);

    const res = await request(createApp(agentActor(seed.companyId, seed.peerAgentId, seed.peerRunId)))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Peer edit over a live lock" });

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details.code).toBe("issue_write_assignee_run_lock");
    expect(res.body.details.boundary).toBe("Run checkout lock");
    expect(res.body.error).toContain("a run is live");
    expect(res.body.error).not.toMatch(/dead|stale|terminal/i);
    expect(res.body.details.checkoutRunId).toBe(seed.liveRunId);
    expect(res.body.details.checkoutRunDead).toBeUndefined();
    expect(res.body.details.checkoutRunStatus).toBeUndefined();
    expect(res.body.details.checkoutRunDeadSince).toBeUndefined();
  });

  it("lets a manage-active-checkouts holder edit a locked issue but not release it", async () => {
    const seed = await seedDeadRunLock();
    const issueId = await seedLockedIssue(seed.companyId, seed.ownerAgentId, seed.deadRunId);
    await bindRunsToIssue([seed.grantRunId], issueId);
    const grantActor = agentActor(seed.companyId, seed.grantAgentId, seed.grantRunId);

    // The override permits cross-agent field mutation of the locked issue.
    const patched = await request(createApp(grantActor))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Managed edit over the lock" });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.title).toBe("Managed edit over the lock");

    // The same holder editing the locked issue leaves the lock itself intact.
    expect(await loadIssue(issueId)).toMatchObject({
      title: "Managed edit over the lock",
      status: "in_progress",
      assigneeAgentId: seed.ownerAgentId,
      checkoutRunId: seed.deadRunId,
    });

    // The gap: the override does NOT extend to the lock-release routes. The
    // service rejects non-assignee actors, so a grant holder cannot clear even
    // a dead run's lock. Flagged for Ahti-CTO, not fixed here.
    const released = await request(createApp(grantActor))
      .post(`/api/issues/${issueId}/release`)
      .send();
    expect(released.status, JSON.stringify(released.body)).toBe(409);
    expect(released.body.error).toBe("Only assignee can release issue");
    expect(await loadIssue(issueId)).toMatchObject({ checkoutRunId: seed.deadRunId });
  });

  it("denies a peer without the grant at the run-lock gate before the release service", async () => {
    const seed = await seedDeadRunLock();
    const issueId = await seedLockedIssue(seed.companyId, seed.ownerAgentId, seed.deadRunId);
    await bindRunsToIssue([seed.peerRunId], issueId);

    const res = await request(createApp(agentActor(seed.companyId, seed.peerAgentId, seed.peerRunId)))
      .post(`/api/issues/${issueId}/release`)
      .send();

    expect(res.status, JSON.stringify(res.body)).toBe(409);
    expect(res.body.details.code).toBe("issue_write_assignee_run_lock");
    expect(res.body.error).toContain(seed.deadRunId);
    expect(await loadIssue(issueId)).toMatchObject({ checkoutRunId: seed.deadRunId });
  });

  it("lets a board member edit a dead-locked issue and force-release the lock", async () => {
    const seed = await seedDeadRunLock();
    const issueId = await seedLockedIssue(seed.companyId, seed.ownerAgentId, seed.deadRunId);
    const board = boardActor(seed.companyId);

    const patched = await request(createApp(board))
      .patch(`/api/issues/${issueId}`)
      .send({ title: "Board edit over the lock" });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect(patched.body.title).toBe("Board edit over the lock");

    const released = await request(createApp(board))
      .post(`/api/issues/${issueId}/admin/force-release`)
      .send();
    expect(released.status, JSON.stringify(released.body)).toBe(200);
    // Without ?clearAssignee the assignment survives; the lock clears.
    expect(released.body.issue).toMatchObject({
      id: issueId,
      assigneeAgentId: seed.ownerAgentId,
      checkoutRunId: null,
      executionRunId: null,
    });

    const audit = await db
      .select({ action: activityLog.action })
      .from(activityLog)
      .where(eq(activityLog.action, "issue.admin_force_release"));
    expect(audit).toHaveLength(1);
    expect(await loadIssue(issueId)).toMatchObject({
      title: "Board edit over the lock",
      status: "in_progress",
      assigneeAgentId: seed.ownerAgentId,
      checkoutRunId: null,
    });
  });

  it("lets a board member clear the lock via the plain release route", async () => {
    const seed = await seedDeadRunLock();
    const issueId = await seedLockedIssue(seed.companyId, seed.ownerAgentId, seed.deadRunId);

    const res = await request(createApp(boardActor(seed.companyId)))
      .post(`/api/issues/${issueId}/release`)
      .send();

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // svc.release without an agent actor skips the assignee guard and requeues
    // the in-progress work, clearing the dead run's lock.
    expect(await loadIssue(issueId)).toMatchObject({
      status: "todo",
      assigneeAgentId: null,
      checkoutRunId: null,
    });
  });
});
