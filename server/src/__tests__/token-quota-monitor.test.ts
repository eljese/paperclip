import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TOKEN_QUOTA_MONITOR_SERVICE_NAME } from "@paperclipai/shared";
import {
  activityLog,
  agentRuntimeState,
  agentWakeupRequests,
  agents,
  companies,
  companySkills,
  createDb,
  documentRevisions,
  documents,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueRecoveryActions,
  issueDocuments,
  issues,
  tokenQuotaMonitorState,
  workspaceRuntimeServices,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import {
  advanceMonitorNextCheckAt,
  buildIssueMonitorRearmedPatch,
  buildIssueMonitorTriggeredPatch,
  mergePreservedExecutionPolicyMonitor,
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
  resolveCanonicalMonitorExternalRef,
  resolveMonitorRearmIntervalMs,
  skipMissedMonitorIntervals,
} from "../services/issue-execution-policy.ts";
import {
  buildTokenQuotaRoutingFingerprint,
  isAllowlistedTokenQuotaRef,
  mergeNotifiedKeys,
  pollTokenQuotaMonitor,
  thresholdNotificationIdentity,
  type TokenQuotaFetch,
} from "../services/token-quota-monitor.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping token-quota monitor tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const ALLOWLISTED_ORIGIN = "http://127.0.0.1:8787";
const HEALTHZ_URL = `${ALLOWLISTED_ORIGIN}/healthz`;
const STATUS_URL = `${ALLOWLISTED_ORIGIN}/v1/status`;
const RESETS_AT = "2026-04-11T13:00:00.000Z";

function baseModels() {
  return [
    {
      id: "model-a",
      available: true,
      disabled: false,
      degraded: false,
      roles: ["exec"],
      executorProvider: "pi_local",
    },
  ];
}

function statusBody(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    providers: [
      {
        id: "pi_local",
        ok: true,
        windows: [{ label: "hourly", usedPercent: 40, resetsAt: RESETS_AT }],
      },
    ],
    controlPlane: { models: baseModels() },
    ...overrides,
  };
}

function mockFetch(
  routes: Record<string, unknown>,
  calls: string[],
  onCall?: (url: string) => void,
): TokenQuotaFetch {
  return async (url: string, _init: { signal: AbortSignal }) => {
    calls.push(url);
    onCall?.(url);
    const body = routes[url];
    if (body instanceof Error) throw body;
    if (body === undefined) throw new Error(`unexpected token-quota fetch: ${url}`);
    return { status: 200, json: async () => body };
  };
}

function healthyFetch(calls: string[], overrides: Record<string, unknown> = {}) {
  return mockFetch({ [HEALTHZ_URL]: { ok: true }, [STATUS_URL]: statusBody(overrides) }, calls);
}

describe("token-quota poll pure functions", () => {
  it("only allowlists the loopback plan-dash origin", () => {
    expect(isAllowlistedTokenQuotaRef("http://127.0.0.1:8787")).toBe(true);
    expect(isAllowlistedTokenQuotaRef("http://127.0.0.1:8787/healthz")).toBe(true);
    expect(isAllowlistedTokenQuotaRef("http://[::1]:8787")).toBe(true);
    expect(isAllowlistedTokenQuotaRef("http://example.com")).toBe(false);
    expect(isAllowlistedTokenQuotaRef("http://127.0.0.1:8787.evil.test")).toBe(false);
    expect(isAllowlistedTokenQuotaRef("https://127.0.0.1:8787")).toBe(false);
    expect(isAllowlistedTokenQuotaRef("http://127.0.0.1:9999")).toBe(false);
    expect(isAllowlistedTokenQuotaRef(null)).toBe(false);
    expect(isAllowlistedTokenQuotaRef("[redacted]")).toBe(false);
  });

  it("never fetches a non-allowlisted ref", async () => {
    const calls: string[] = [];
    const outcome = await pollTokenQuotaMonitor({
      canonicalRef: "http://example.com",
      fetchImpl: mockFetch({}, calls),
      notifiedKeys: [],
      baselineFingerprint: null,
    });
    expect(outcome).toMatchObject({ allowed: false });
    expect(calls).toHaveLength(0);
  });

  it("reports healthy with zero conditions on a clean poll and stores the baseline", async () => {
    const calls: string[] = [];
    const outcome = await pollTokenQuotaMonitor({
      canonicalRef: ALLOWLISTED_ORIGIN,
      fetchImpl: healthyFetch(calls),
      notifiedKeys: [],
      baselineFingerprint: null,
    });
    expect(outcome.allowed).toBe(true);
    if (!outcome.allowed) return;
    expect(outcome.healthy).toBe(true);
    expect(outcome.conditions).toHaveLength(0);
    expect(outcome.fingerprint).not.toBeNull();
    expect(calls).toEqual([HEALTHZ_URL, STATUS_URL]);
  });

  it("wakes once for transport failure with a stable identity", async () => {
    const calls: string[] = [];
    const first = await pollTokenQuotaMonitor({
      canonicalRef: ALLOWLISTED_ORIGIN,
      fetchImpl: mockFetch({ [HEALTHZ_URL]: new Error(" refused ") }, calls),
      notifiedKeys: [],
      baselineFingerprint: null,
    });
    expect(first.allowed).toBe(true);
    if (!first.allowed) return;
    expect(first.healthy).toBe(false);
    expect(first.conditions.map((c) => c.kind)).toEqual(["health"]);
    const keys = mergeNotifiedKeys([], first.consumeKeys, first.resolveKeys);
    const second = await pollTokenQuotaMonitor({
      canonicalRef: ALLOWLISTED_ORIGIN,
      fetchImpl: mockFetch({ [HEALTHZ_URL]: new Error(" refused ") }, calls),
      notifiedKeys: keys,
      baselineFingerprint: first.fingerprint,
    });
    expect(second.allowed).toBe(true);
    if (!second.allowed) return;
    expect(second.conditions).toHaveLength(0);
  });

  it("wakes for provider ok=false and low remaining quota with plan-dash threshold identity", async () => {
    const calls: string[] = [];
    const outcome = await pollTokenQuotaMonitor({
      canonicalRef: ALLOWLISTED_ORIGIN,
      fetchImpl: healthyFetch(calls, {
        providers: [
          { id: "pi_local", ok: false, windows: [] },
          {
            id: "other",
            ok: true,
            windows: [{ label: "daily", usedPercent: 90, resetsAt: RESETS_AT }],
          },
        ],
      }),
      notifiedKeys: [],
      baselineFingerprint: buildTokenQuotaRoutingFingerprint(baseModels()),
    });
    expect(outcome.allowed).toBe(true);
    if (!outcome.allowed) return;
    expect(outcome.healthy).toBe(false);
    const kinds = outcome.conditions.map((c) => c.kind).sort();
    expect(kinds).toEqual(["low_remaining", "provider_not_ok"]);
    const threshold = outcome.conditions.find((c) => c.kind === "low_remaining")!;
    expect(threshold.identity).toBe(
      thresholdNotificationIdentity({ providerId: "other", windowLabel: "daily", resetsAt: RESETS_AT }),
    );
    expect(threshold.details).toMatchObject({ thresholdPercent: 15, remainingPercent: 10 });
  });

  it("does not wake at exactly the 15% remaining boundary", async () => {
    const calls: string[] = [];
    const outcome = await pollTokenQuotaMonitor({
      canonicalRef: ALLOWLISTED_ORIGIN,
      fetchImpl: healthyFetch(calls, {
        providers: [
          { id: "pi_local", ok: true, windows: [{ label: "hourly", usedPercent: 85, resetsAt: RESETS_AT }] },
        ],
      }),
      notifiedKeys: [],
      baselineFingerprint: buildTokenQuotaRoutingFingerprint(baseModels()),
    });
    expect(outcome.allowed).toBe(true);
    if (!outcome.allowed) return;
    expect(outcome.healthy).toBe(true);
  });

  it("wakes once when the routing fingerprint changes and ignores remainingPercent drift", async () => {
    const calls: string[] = [];
    const baseline = buildTokenQuotaRoutingFingerprint(baseModels())!;
    const drifted = baseModels().map((m) => ({ ...m, remainingPercent: 3, recentEvents: [1, 2, 3] }));
    const same = await pollTokenQuotaMonitor({
      canonicalRef: ALLOWLISTED_ORIGIN,
      fetchImpl: healthyFetch(calls, { controlPlane: { models: drifted } }),
      notifiedKeys: [],
      baselineFingerprint: baseline,
    });
    expect(same.allowed).toBe(true);
    if (!same.allowed) return;
    expect(same.healthy).toBe(true);

    const changedModels = [{ ...baseModels()[0], available: false }];
    const changed = await pollTokenQuotaMonitor({
      canonicalRef: ALLOWLISTED_ORIGIN,
      fetchImpl: healthyFetch(calls, { controlPlane: { models: changedModels } }),
      notifiedKeys: [],
      baselineFingerprint: baseline,
    });
    expect(changed.allowed).toBe(true);
    if (!changed.allowed) return;
    expect(changed.conditions.map((c) => c.kind)).toEqual(["fingerprint_changed"]);
  });
});

describe("monitor policy helpers", () => {
  it("pins token-quota to the allowlisted origin and ignores agent URLs", () => {
    expect(
      resolveCanonicalMonitorExternalRef({ serviceName: "token-quota", rawExternalRef: "http://example.com" }),
    ).toBe(ALLOWLISTED_ORIGIN);
    expect(
      resolveCanonicalMonitorExternalRef({ serviceName: "other", rawExternalRef: "http://example.com/x" }),
    ).toBe("http://example.com/x");
    expect(resolveCanonicalMonitorExternalRef({ serviceName: "other", rawExternalRef: "  " })).toBeNull();
  });

  it("defaults token-quota re-arm to one hour and honors stored intervals", () => {
    expect(resolveMonitorRearmIntervalMs({ nextCheckAt: "", notes: null, scheduledBy: "assignee", serviceName: "token-quota" })).toBe(3_600_000);
    expect(
      resolveMonitorRearmIntervalMs({ nextCheckAt: "", notes: null, scheduledBy: "assignee", intervalMs: 1_800_000 }),
    ).toBe(1_800_000);
    expect(
      resolveMonitorRearmIntervalMs({ nextCheckAt: "", notes: null, scheduledBy: "assignee", serviceName: "other" }),
    ).toBeNull();
  });

  it("advances nextCheckAt by the interval", () => {
    expect(advanceMonitorNextCheckAt("2026-04-11T12:30:00.000Z", 3_600_000)).toBe("2026-04-11T13:30:00.000Z");
  });

  it("keeps scheduled+interval within one interval but skips fully-missed slots after downtime", () => {
    const scheduled = new Date("2026-04-11T12:30:00.000Z").getTime();
    expect(
      skipMissedMonitorIntervals(scheduled, 3_600_000, scheduled + 60_000).toISOString(),
    ).toBe("2026-04-11T13:30:00.000Z");
    const jumped = skipMissedMonitorIntervals(scheduled, 3_600_000, scheduled + 5 * 3_600_000 + 60_000);
    expect(jumped.getTime()).toBeGreaterThan(scheduled + 5 * 3_600_000 + 60_000);
    expect(jumped.toISOString()).toBe("2026-04-11T18:30:00.000Z");
  });

  it("flags a status response missing providers or routing models instead of reading healthy", async () => {
    const calls: string[] = [];
    const outcome = await pollTokenQuotaMonitor({
      canonicalRef: ALLOWLISTED_ORIGIN,
      fetchImpl: mockFetch(
        { [HEALTHZ_URL]: { ok: true }, [STATUS_URL]: { ok: true } },
        calls,
      ),
      notifiedKeys: [],
      baselineFingerprint: null,
    });
    expect(outcome.allowed).toBe(true);
    if (!outcome.allowed) return;
    expect(outcome.healthy).toBe(false);
    expect(outcome.conditions.map((c) => c.identity)).toEqual(["status:invalid-shape"]);
    expect(outcome.conditions.map((c) => c.kind)).toEqual(["health"]);
    const keys = mergeNotifiedKeys([], outcome.consumeKeys, outcome.resolveKeys);
    const recovered = await pollTokenQuotaMonitor({
      canonicalRef: ALLOWLISTED_ORIGIN,
      fetchImpl: healthyFetch(calls),
      notifiedKeys: keys,
      baselineFingerprint: outcome.fingerprint,
    });
    expect(recovered.allowed).toBe(true);
    if (!recovered.allowed) return;
    expect(recovered.healthy).toBe(true);
    expect(recovered.conditions).toHaveLength(0);
  });

  it("preserves the monitor when a PATCH omits the key and clears on explicit null", () => {
    const previous = normalizeIssueExecutionPolicy({
      monitor: { nextCheckAt: "2026-04-11T12:30:00.000Z", serviceName: "token-quota" },
      stages: [],
    })!;
    const incoming = normalizeIssueExecutionPolicy({ stages: [] });
    const preserved = mergePreservedExecutionPolicyMonitor({
      previous,
      next: incoming,
      rawMonitorKeyPresent: false,
    });
    expect(preserved?.monitor?.serviceName).toBe("token-quota");
    const cleared = mergePreservedExecutionPolicyMonitor({
      previous,
      next: incoming,
      rawMonitorKeyPresent: true,
    });
    expect(cleared?.monitor ?? null).toBeNull();
  });

  it("re-arms without consuming attempts on healthy checks and preserves metadata on trigger", () => {
    const policy = normalizeIssueExecutionPolicy({
      monitor: {
        nextCheckAt: "2026-04-11T12:30:00.000Z",
        serviceName: "token-quota",
        kind: "external_service",
        timeoutAt: "2026-04-12T12:30:00.000Z",
        maxAttempts: 10,
        recoveryPolicy: "wake_owner",
        scheduledBy: "assignee",
      },
      stages: [],
    })!;
    const issue = {
      status: "in_progress",
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      executionPolicy: policy,
      executionState: null,
      monitorNextCheckAt: new Date("2026-04-11T12:30:00.000Z"),
      monitorWakeRequestedAt: null,
      monitorLastTriggeredAt: null,
      monitorAttemptCount: 3,
      monitorNotes: null,
      monitorScheduledBy: "assignee",
    };
    const rearmed = buildIssueMonitorRearmedPatch({
      issue,
      policy,
      checkedAt: new Date("2026-04-11T12:31:00.000Z"),
      rearmedNextCheckAt: new Date("2026-04-11T13:30:00.000Z"),
    });
    expect(rearmed.monitorAttemptCount).toBe(3);
    expect((rearmed.monitorNextCheckAt as Date).toISOString()).toBe("2026-04-11T13:30:00.000Z");
    expect(parseIssueExecutionState(rearmed.executionState)?.monitor).toMatchObject({
      status: "scheduled",
      serviceName: "token-quota",
      maxAttempts: 10,
      attemptCount: 3,
    });

    const triggered = buildIssueMonitorTriggeredPatch({
      issue,
      policy,
      triggeredAt: new Date("2026-04-11T12:31:00.000Z"),
      rearmedNextCheckAt: new Date("2026-04-11T13:30:00.000Z"),
    });
    expect(triggered.monitorAttemptCount).toBe(4);
    expect(normalizeIssueExecutionPolicy(triggered.executionPolicy)?.monitor?.serviceName).toBe("token-quota");
    expect((triggered.monitorNextCheckAt as Date).toISOString()).toBe("2026-04-11T13:30:00.000Z");
  });
});

describeEmbeddedPostgres("token-quota monitor scheduler", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const seededAgentIds = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-token-quota-monitor-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  async function waitForHeartbeatIdle(timeoutMs = 3_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const active = await db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`);
      if (active.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Timed out waiting for token-quota heartbeat runs to settle");
  }

  async function heartbeatSideEffectFingerprint() {
    const [active, events, activity, leases, runtimeServices] = await Promise.all([
      db
        .select({ count: sql<number>`count(*)` })
        .from(heartbeatRuns)
        .where(sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`),
      db.select({ count: sql<number>`count(*)` }).from(heartbeatRunEvents),
      db.select({ count: sql<number>`count(*)` }).from(activityLog),
      db.select({ count: sql<number>`count(*)` }).from(environmentLeases),
      db.select({ count: sql<number>`count(*)` }).from(workspaceRuntimeServices),
    ]);
    return [
      active[0]?.count ?? 0,
      events[0]?.count ?? 0,
      activity[0]?.count ?? 0,
      leases[0]?.count ?? 0,
      runtimeServices[0]?.count ?? 0,
    ].join(":");
  }

  async function waitForHeartbeatSideEffectsSettled(timeoutMs = 5_000, quietMs = 500) {
    const deadline = Date.now() + timeoutMs;
    let previous = "";
    let stableSince = Date.now();
    while (Date.now() < deadline) {
      const current = await heartbeatSideEffectFingerprint();
      const activeCount = Number(current.split(":")[0] ?? 0);
      if (current !== previous || activeCount > 0) {
        previous = current;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= quietMs) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Timed out waiting for token-quota heartbeat side effects to settle");
  }

  async function cleanupRows() {
    await waitForHeartbeatSideEffectsSettled();
    await db.delete(heartbeatRunEvents);
    await db.delete(issueRecoveryActions);
    await db.delete(issueComments);
    await db.delete(documentRevisions);
    await db.delete(issueDocuments);
    await db.delete(documents);
    await db.delete(activityLog);
    await db.delete(environmentLeases);
    await db.delete(workspaceRuntimeServices);
    await db.delete(tokenQuotaMonitorState);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  }

  afterEach(async () => {
    const heartbeat = heartbeatService(db);
    await heartbeat.drainActiveRunExecutions();
    const pending = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(sql`${heartbeatRuns.status} in ('queued', 'running', 'scheduled_retry')`);
    for (const run of pending) await heartbeat.cancelRun(run.id, "Token-quota fixture teardown", { suppressImmediateRecovery: true });
    await heartbeat.drainActiveRunExecutions();
    seededAgentIds.clear();
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await cleanupRows();
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw lastError;
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedTokenQuotaFixture(input?: {
    issueStatus?: "in_progress" | "in_review" | "todo";
    monitorAttemptCount?: number;
    externalRef?: string | null;
    intervalMs?: number | null;
    maxAttempts?: number | null;
    nextCheckAt?: Date;
    userAssignee?: boolean;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const nextCheckAt = input?.nextCheckAt ?? new Date("2026-04-11T12:30:00.000Z");
    const issuePrefix = `Q${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const monitorAttemptCount = input?.monitorAttemptCount ?? 0;
    const monitor: Record<string, unknown> = {
      nextCheckAt: nextCheckAt.toISOString(),
      notes: "Token quota watch",
      scheduledBy: "assignee",
      kind: "external_service",
      serviceName: TOKEN_QUOTA_MONITOR_SERVICE_NAME,
    };
    if (input?.intervalMs !== undefined && input.intervalMs !== null) {
      monitor.intervalMs = input.intervalMs;
    }
    if (input?.maxAttempts !== undefined && input.maxAttempts !== null) {
      monitor.maxAttempts = input.maxAttempts;
    }

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Quota Bot",
      role: "engineer",
      status: "active",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", ""], cwd: process.cwd() },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
      permissions: {},
    });
    seededAgentIds.add(agentId);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Watch token quota",
      status: input?.issueStatus ?? "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      ...(input?.userAssignee ? { assigneeUserId: "some-user" } : {}),
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      executionPolicy: { mode: "normal", commentRequired: true, stages: [], monitor },
      executionState: {
        status: "idle",
        currentStageId: null,
        currentStageIndex: null,
        currentStageType: null,
        currentParticipant: null,
        returnAssignee: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
        monitor: {
          status: "scheduled",
          nextCheckAt: nextCheckAt.toISOString(),
          lastTriggeredAt: null,
          attemptCount: monitorAttemptCount,
          notes: "Token quota watch",
          scheduledBy: "assignee",
          kind: "external_service",
          serviceName: TOKEN_QUOTA_MONITOR_SERVICE_NAME,
          externalRef: "[redacted]",
          timeoutAt: null,
          maxAttempts: input?.maxAttempts ?? null,
          recoveryPolicy: null,
          clearedAt: null,
          clearReason: null,
        },
      },
      monitorNextCheckAt: nextCheckAt,
      monitorAttemptCount,
      monitorNotes: "Token quota watch",
      monitorScheduledBy: "assignee",
      monitorExternalRef: input?.externalRef === undefined ? ALLOWLISTED_ORIGIN : input.externalRef,
    });
    return { companyId, agentId, issueId, nextCheckAt };
  }

  async function readIssue(issueId: string) {
    return db.select().from(issues).where(eq(issues.id, issueId)).then((rows) => rows[0]!);
  }

  it("healthy polls start zero Pi runs, keep the monitor, and re-arm by one hour by default", async () => {
    const { issueId } = await seedTokenQuotaFixture();
    const calls: string[] = [];
    const result = await heartbeatService(db).tickTimers(new Date("2026-04-11T12:31:00.000Z"), {
      fetchImpl: healthyFetch(calls),
    });

    expect(result.enqueued).toBe(0);
    expect(calls).toEqual([HEALTHZ_URL, STATUS_URL]);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);

    const issue = await readIssue(issueId);
    expect(issue.monitorNextCheckAt?.toISOString()).toBe("2026-04-11T13:30:00.000Z");
    expect(issue.monitorAttemptCount).toBe(0);
    expect(issue.monitorWakeRequestedAt).toBeNull();
    expect(normalizeIssueExecutionPolicy(issue.executionPolicy ?? null)?.monitor).toMatchObject({
      serviceName: TOKEN_QUOTA_MONITOR_SERVICE_NAME,
      kind: "external_service",
    });
    const actions = await db.select().from(activityLog).where(eq(activityLog.entityId, issueId))
      .then((rows) => rows.map((row) => row.action));
    expect(actions).toContain("issue.monitor_checked");

    const state = await db.select().from(tokenQuotaMonitorState).where(eq(tokenQuotaMonitorState.issueId, issueId))
      .then((rows) => rows[0] ?? null);
    expect(state?.routingFingerprint).not.toBeNull();
    expect(state?.notifiedKeys).toEqual([]);
  });

  it("honors an explicit stored interval when re-arming", async () => {
    const { issueId } = await seedTokenQuotaFixture({ intervalMs: 1_800_000 });
    const calls: string[] = [];
    await heartbeatService(db).tickTimers(new Date("2026-04-11T12:31:00.000Z"), {
      fetchImpl: healthyFetch(calls),
    });
    const issue = await readIssue(issueId);
    expect(issue.monitorNextCheckAt?.toISOString()).toBe("2026-04-11T13:00:00.000Z");
  });

  it("never fetches a non-allowlisted externalRef", async () => {
    const { issueId } = await seedTokenQuotaFixture({ externalRef: "http://example.com" });
    const calls: string[] = [];
    const result = await heartbeatService(db).tickTimers(new Date("2026-04-11T12:31:00.000Z"), {
      fetchImpl: mockFetch({}, calls),
    });
    expect(calls).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    const issue = await readIssue(issueId);
    expect(issue.monitorNextCheckAt).not.toBeNull();
  });

  it("wakes once on transport failure without clearing the monitor", async () => {
    const { issueId, agentId } = await seedTokenQuotaFixture();
    const calls: string[] = [];
    const failing = mockFetch({ [HEALTHZ_URL]: new Error("connect refused") }, calls);
    const result = await heartbeatService(db).tickTimers(new Date("2026-04-11T12:31:00.000Z"), {
      fetchImpl: failing,
    });
    expect(result.enqueued).toBe(1);
    const wakeups = await db.select().from(agentWakeupRequests);
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({ agentId, reason: "issue_monitor_due" });
    expect(wakeups[0]?.idempotencyKey).toBe(
      `token-quota:${issueId}:health:unreachable:2026-04-11T12:30:00.000Z`,
    );

    const issue = await readIssue(issueId);
    expect(issue.monitorNextCheckAt?.toISOString()).toBe("2026-04-11T13:30:00.000Z");
    expect(issue.monitorAttemptCount).toBe(1);
    expect(normalizeIssueExecutionPolicy(issue.executionPolicy ?? null)?.monitor?.serviceName)
      .toBe(TOKEN_QUOTA_MONITOR_SERVICE_NAME);

    // Duplicate tick for the re-armed instant does not duplicate the wake.
    await heartbeatService(db).tickTimers(new Date("2026-04-11T12:31:00.000Z"), { fetchImpl: failing });
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(1);
  });

  it("wakes once per threshold window and stays silent on repeat polls", async () => {
    const { issueId } = await seedTokenQuotaFixture();
    const lowBody = statusBody({
      providers: [
        { id: "pi_local", ok: true, windows: [{ label: "hourly", usedPercent: 90, resetsAt: RESETS_AT }] },
      ],
    });
    const calls: string[] = [];
    const low = mockFetch({ [HEALTHZ_URL]: { ok: true }, [STATUS_URL]: lowBody }, calls);
    await heartbeatService(db).tickTimers(new Date("2026-04-11T12:31:00.000Z"), { fetchImpl: low });
    let wakeups = await db.select().from(agentWakeupRequests);
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]?.payload).toMatchObject({
      tokenQuotaCondition: "low_remaining",
      tokenQuotaConditionIdentity: `threshold:pi_local:hourly:${RESETS_AT}`,
    });
    expect((await readIssue(issueId)).monitorAttemptCount).toBe(1);

    await heartbeatService(db).tickTimers(new Date("2026-04-11T13:31:00.000Z"), { fetchImpl: low });
    wakeups = await db.select().from(agentWakeupRequests);
    expect(wakeups).toHaveLength(1);
    expect((await readIssue(issueId)).monitorAttemptCount).toBe(1);
  });

  it("wakes once when the routing fingerprint changes after the baseline", async () => {
    const { issueId } = await seedTokenQuotaFixture();
    const calls: string[] = [];
    await heartbeatService(db).tickTimers(new Date("2026-04-11T12:31:00.000Z"), {
      fetchImpl: healthyFetch(calls),
    });
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);

    const changed = mockFetch(
      {
        [HEALTHZ_URL]: { ok: true },
        [STATUS_URL]: statusBody({ controlPlane: { models: [{ ...baseModels()[0], degraded: true }] } }),
      },
      calls,
    );
    await heartbeatService(db).tickTimers(new Date("2026-04-11T13:31:00.000Z"), { fetchImpl: changed });
    const wakeups = await db.select().from(agentWakeupRequests);
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]?.payload).toMatchObject({ tokenQuotaCondition: "fingerprint_changed" });
  });

  it("reclaims a stale claim without duplicating the run for a completed instant", async () => {
    const { issueId } = await seedTokenQuotaFixture();
    const stale = new Date("2026-04-11T12:20:00.000Z");
    await db.update(issues).set({ monitorWakeRequestedAt: stale }).where(eq(issues.id, issueId));
    const calls: string[] = [];
    await heartbeatService(db).tickTimers(new Date("2026-04-11T12:31:00.000Z"), {
      fetchImpl: healthyFetch(calls),
    });
    const issue = await readIssue(issueId);
    expect(issue.monitorNextCheckAt?.toISOString()).toBe("2026-04-11T13:30:00.000Z");
    expect(issue.monitorWakeRequestedAt).toBeNull();
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns)).toHaveLength(0);
  });

  it("does not fire for ineligible issues", async () => {
    const todo = await seedTokenQuotaFixture({ issueStatus: "todo" });
    const userOwned = await seedTokenQuotaFixture({ userAssignee: true });
    void todo;
    const calls: string[] = [];
    await heartbeatService(db).tickTimers(new Date("2026-04-11T12:31:00.000Z"), {
      fetchImpl: healthyFetch(calls),
    });
    expect(calls).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
    expect((await readIssue(userOwned.issueId)).monitorNextCheckAt?.toISOString())
      .toBe("2026-04-11T12:30:00.000Z");
  });

  it("keeps the canonical ref in its column across dispatch and reload, never in redacted JSON", async () => {
    const { issueId } = await seedTokenQuotaFixture({ externalRef: ALLOWLISTED_ORIGIN });
    const calls: string[] = [];
    await heartbeatService(db).tickTimers(new Date("2026-04-11T12:31:00.000Z"), {
      fetchImpl: healthyFetch(calls),
    });
    // Service-reload simulation: re-read the row fresh and poll again.
    const reloaded = await readIssue(issueId);
    expect(reloaded.monitorExternalRef).toBe(ALLOWLISTED_ORIGIN);
    expect(JSON.stringify(reloaded.executionPolicy)).not.toContain("127.0.0.1");

    const heartbeat = heartbeatService(db);
    await heartbeat.triggerIssueMonitor(issueId, {
      now: new Date("2026-04-11T13:31:00.000Z"),
      actorType: "system",
      fetchImpl: healthyFetch(calls),
    });
    const after = await readIssue(issueId);
    expect(after.monitorExternalRef).toBe(ALLOWLISTED_ORIGIN);
    expect(after.monitorExternalRef).not.toBe("[redacted]");
    expect(after.monitorNextCheckAt?.toISOString()).toBe("2026-04-11T14:30:00.000Z");
  });

  it("emits one idempotent alert with one wake when a required monitor is exhausted", async () => {
    const { issueId, agentId } = await seedTokenQuotaFixture({ monitorAttemptCount: 1, maxAttempts: 1 });
    const calls: string[] = [];
    const failing = mockFetch({ [HEALTHZ_URL]: new Error("connect refused") }, calls);
    const tickAt = new Date("2026-04-11T12:31:00.000Z");
    const result = await heartbeatService(db).tickTimers(tickAt, { fetchImpl: failing });
    expect(result.skipped).toBe(1);

    const alerts = await db.select().from(activityLog)
      .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.monitor_required_missing")));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.details).toMatchObject({ reason: "max_attempts_exhausted" });
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(1);
    const wakeups = await db.select().from(agentWakeupRequests);
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({ agentId, reason: "issue_monitor_required_missing" });

    // Repeating the same exhausted instant does not duplicate the alert.
    const cleared = await readIssue(issueId);
    await db.update(issues).set({
      executionPolicy: {
        mode: "normal",
        commentRequired: true,
        stages: [],
        monitor: {
          nextCheckAt: new Date("2026-04-11T12:30:00.000Z").toISOString(),
          notes: "Token quota watch",
          scheduledBy: "assignee",
          kind: "external_service",
          serviceName: TOKEN_QUOTA_MONITOR_SERVICE_NAME,
          maxAttempts: 1,
        },
      },
      monitorNextCheckAt: new Date("2026-04-11T12:30:00.000Z"),
      monitorAttemptCount: 1,
    }).where(eq(issues.id, issueId));
    void cleared;
    await heartbeatService(db).tickTimers(tickAt, { fetchImpl: failing });
    expect(
      await db.select().from(activityLog)
        .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.monitor_required_missing"))),
    ).toHaveLength(1);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, issueId))).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(1);
  });

  it("does not alert for expected done clears", async () => {
    const { issueId } = await seedTokenQuotaFixture({ issueStatus: "todo" });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
    const calls: string[] = [];
    await heartbeatService(db).tickTimers(new Date("2026-04-11T12:31:00.000Z"), {
      fetchImpl: healthyFetch(calls),
    });
    expect(calls).toHaveLength(0);
    expect(
      await db.select().from(activityLog)
        .where(and(eq(activityLog.entityId, issueId), eq(activityLog.action, "issue.monitor_required_missing"))),
    ).toHaveLength(0);
    expect(await db.select().from(agentWakeupRequests)).toHaveLength(0);
  });

  it("drains cleanly", async () => {
    await heartbeatService(db).drainActiveRunExecutions();
    await waitForHeartbeatIdle();
  });
});
