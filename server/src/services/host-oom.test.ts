import { describe, expect, it } from "vitest";
import {
  HOST_OOM_ERROR_CODE,
  HOST_OOM_MAX_ATTEMPTS,
  HOST_OOM_RETRY_DELAYS_MS,
  HOST_OOM_RETRY_REASON,
  attributeHostOomErrorCode,
  computeHostOomRetrySchedule,
  isGenericInfraDeathCode,
  isHostOomActive,
  isHostOomRetryEnabled,
  readMemoryEventsOomKill,
  shouldSuppressDispatchDueToHostOom,
} from "./host-oom.js";
import {
  accountingForScheduledRetry,
  executionFailureRetryCount,
  executionRetryAttemptCount,
} from "./execution-recovery-attempt.js";

describe("host-oom detection (JES-342)", () => {
  it("is inactive by default (no marker, no cgroup, no env) — dispatch guard no-op", () => {
    const fs = {
      existsSync: () => false,
      readFileSync: () => "",
      statSync: () => ({ mtimeMs: Date.now() }),
    };
    expect(
      isHostOomActive({ env: {}, fs, nowMs: Date.now() }),
    ).toMatchObject({ active: false, reason: null });
    expect(shouldSuppressDispatchDueToHostOom({ env: {}, fs })).toBe(false);
  });

  it("detects OOM via env override true/false", () => {
    expect(
      isHostOomActive({ env: { PAPERCLIP_HOST_OOM_ACTIVE: "1" } }).active,
    ).toBe(true);
    expect(
      isHostOomActive({ env: { PAPERCLIP_HOST_OOM_ACTIVE: "1" } }).reason,
    ).toBe("env_override");
    expect(
      isHostOomActive({ env: { PAPERCLIP_HOST_OOM_ACTIVE: "0" } }).active,
    ).toBe(false);
    expect(
      shouldSuppressDispatchDueToHostOom({
        env: { PAPERCLIP_HOST_OOM_ACTIVE: "1" },
      }),
    ).toBe(true);
    expect(
      shouldSuppressDispatchDueToHostOom({
        env: { PAPERCLIP_HOST_OOM_ACTIVE: "0" },
      }),
    ).toBe(false);
  });

  it("detects OOM via marker file within the active window, ignores stale markers", () => {
    const nowMs = 1_700_000_000_000;
    const marker = "/run/paperclipai/host-oom";
    const freshFs = {
      existsSync: (p: string) => p === marker,
      readFileSync: () => "",
      statSync: () => ({ mtimeMs: nowMs - 60_000 }),
    };
    expect(isHostOomActive({ env: {}, fs: freshFs, nowMs })).toMatchObject({
      active: true,
      reason: "marker_file",
    });
    const staleFs = {
      existsSync: (p: string) => p === marker,
      readFileSync: () => "",
      statSync: () => ({ mtimeMs: nowMs - 60 * 60_000 }),
    };
    expect(isHostOomActive({ env: {}, fs: staleFs, nowMs }).active).toBe(false);
  });

  it("detects OOM via cgroup memory.events oom_kill with recency", () => {
    const nowMs = 1_700_000_000_000;
    const eventsPath = "/sys/fs/cgroup/memory.events";
    const hitFs = {
      existsSync: (p: string) => p === eventsPath,
      readFileSync: () => "low 0\nhigh 0\nmax 0\noom 0\noom_kill 3\n",
      statSync: () => ({ mtimeMs: nowMs - 5 * 60_000 }),
    };
    expect(isHostOomActive({ env: {}, fs: hitFs, nowMs })).toMatchObject({
      active: true,
      reason: "cgroup_oom_kill",
    });
    const zeroFs = {
      existsSync: (p: string) => p === eventsPath,
      readFileSync: () => "low 0\noom_kill 0\n",
      statSync: () => ({ mtimeMs: nowMs }),
    };
    expect(isHostOomActive({ env: {}, fs: zeroFs, nowMs }).active).toBe(false);
  });

  it("parses memory.events oom_kill counters", () => {
    expect(readMemoryEventsOomKill("oom_kill 11\n")).toBe(11);
    expect(readMemoryEventsOomKill("low 0\noom_kill 0\n")).toBe(0);
    expect(readMemoryEventsOomKill("no counters here")).toBeNull();
  });

  it("never throws when fs is unavailable", () => {
    expect(
      isHostOomActive({
        env: {},
        fs: {
          existsSync: () => {
            throw new Error("fs gone");
          },
        },
      }).active,
    ).toBe(false);
  });
});

describe("host-oom attribution (JES-342)", () => {
  it.each(["process_lost", "adapter_failed", "orphaned_running_run", "orphaned_running_run_issue_terminal"])(
    "records distinct error_code for %s when OOM is active",
    (code) => {
      expect(isGenericInfraDeathCode(code)).toBe(true);
      expect(attributeHostOomErrorCode(code, true)).toBe(HOST_OOM_ERROR_CODE);
    },
  );

  it("keeps the generic code when OOM is not active (no behavior change)", () => {
    for (const code of ["process_lost", "adapter_failed", "orphaned_running_run"]) {
      expect(attributeHostOomErrorCode(code, false)).toBe(code);
    }
  });

  it("never rewrites specific non-generic codes", () => {
    for (const code of [
      "workspace_validation_failed",
      "configuration_incomplete",
      "provider_quota",
      "timeout",
      "cancelled",
    ]) {
      expect(isGenericInfraDeathCode(code)).toBe(false);
      expect(attributeHostOomErrorCode(code, true)).toBe(code);
    }
  });
});

describe("host-oom backoff schedule (JES-342)", () => {
  it("applies exponential backoff 2m -> 8m -> 30m", () => {
    expect(HOST_OOM_RETRY_DELAYS_MS).toEqual([120_000, 480_000, 1_800_000]);
    expect(HOST_OOM_MAX_ATTEMPTS).toBe(3);
    const now = new Date("2026-10-01T17:10:31.000Z");
    expect(computeHostOomRetrySchedule(1, now)).toMatchObject({
      attempt: 1,
      baseDelayMs: 120_000,
      delayMs: 120_000,
      maxAttempts: 3,
    });
    expect(computeHostOomRetrySchedule(1, now)?.dueAt.toISOString()).toBe(
      "2026-10-01T17:12:31.000Z",
    );
    expect(computeHostOomRetrySchedule(2, now)?.delayMs).toBe(480_000);
    expect(computeHostOomRetrySchedule(3, now)?.delayMs).toBe(1_800_000);
    expect(computeHostOomRetrySchedule(4, now)).toBeNull();
    expect(computeHostOomRetrySchedule(0, now)).toBeNull();
  });

  it("retry policy is enabled by default and flaggable off", () => {
    expect(isHostOomRetryEnabled({})).toBe(true);
    expect(isHostOomRetryEnabled({ PAPERCLIP_HOST_OOM_RETRY_ENABLED: "0" })).toBe(
      false,
    );
  });
});

describe("host-oom budget non-consumption (JES-342)", () => {
  it("keeps the bounded failure budget untouched across an all-OOM chain", () => {
    // First death: fresh run, no retries yet.
    const first = {
      scheduledRetryReason: null,
      scheduledRetryAttempt: 0,
      contextSnapshot: null,
    };
    expect(executionFailureRetryCount(first)).toBe(0);
    expect(executionRetryAttemptCount(first, HOST_OOM_RETRY_REASON)).toBe(0);
    expect(executionRetryAttemptCount(first, "transient_failure")).toBe(0);

    // Schedule OOM retry 1: failure budget stays 0, OOM lane goes to 1.
    const afterFirst = accountingForScheduledRetry(first, HOST_OOM_RETRY_REASON, 1);
    expect(afterFirst).toEqual({ version: 1, failureRetries: 0, maxTurnContinuations: 0 });

    const second = {
      scheduledRetryReason: HOST_OOM_RETRY_REASON,
      scheduledRetryAttempt: 1,
      contextSnapshot: {
        executionRetryAccounting: afterFirst,
        failureRetriesBeforeHostOomWait: 0,
      },
    };
    expect(executionFailureRetryCount(second)).toBe(0);
    expect(executionRetryAttemptCount(second, HOST_OOM_RETRY_REASON)).toBe(1);
    expect(executionRetryAttemptCount(second, "transient_failure")).toBe(0);

    // Schedule OOM retry 2: still no failure spend.
    const afterSecond = accountingForScheduledRetry(second, HOST_OOM_RETRY_REASON, 2);
    expect(afterSecond.failureRetries).toBe(0);

    const third = {
      scheduledRetryReason: HOST_OOM_RETRY_REASON,
      scheduledRetryAttempt: 2,
      contextSnapshot: {
        executionRetryAccounting: afterSecond,
        failureRetriesBeforeHostOomWait: 0,
      },
    };
    expect(executionFailureRetryCount(third)).toBe(0);
    expect(executionRetryAttemptCount(third, HOST_OOM_RETRY_REASON)).toBe(2);

    const afterThird = accountingForScheduledRetry(third, HOST_OOM_RETRY_REASON, 3);
    expect(afterThird.failureRetries).toBe(0);
    // A later non-OOM transient failure still starts from a clean bounded budget.
    const oomExhausted = {
      scheduledRetryReason: HOST_OOM_RETRY_REASON,
      scheduledRetryAttempt: 3,
      contextSnapshot: {
        executionRetryAccounting: afterThird,
        failureRetriesBeforeHostOomWait: 0,
      },
    };
    expect(executionFailureRetryCount(oomExhausted)).toBe(0);
    expect(executionRetryAttemptCount(oomExhausted, "transient_failure")).toBe(0);
  });

  it("preserves prior failures through OOM waits without trusting unrelated context", () => {
    expect(
      executionFailureRetryCount({
        scheduledRetryReason: HOST_OOM_RETRY_REASON,
        scheduledRetryAttempt: 12,
        contextSnapshot: { failureRetriesBeforeHostOomWait: 1 },
      }),
    ).toBe(1);
    expect(
      executionFailureRetryCount({
        scheduledRetryReason: "transient_failure",
        scheduledRetryAttempt: 2,
        contextSnapshot: { failureRetriesBeforeHostOomWait: 0 },
      }),
    ).toBe(2);
  });
});
