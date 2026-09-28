import {
  TOKEN_QUOTA_LOW_REMAINING_THRESHOLD_PERCENT,
  TOKEN_QUOTA_MONITOR_ALLOWLISTED_ORIGIN,
} from "@paperclipai/shared";

export const TOKEN_QUOTA_HEALTHZ_PATH = "/healthz";
export const TOKEN_QUOTA_STATUS_PATH = "/v1/status";
export const TOKEN_QUOTA_TOTAL_TIMEOUT_MS = 5_000;
export const TOKEN_QUOTA_NOTIFIED_KEYS_CAP = 50;

export type TokenQuotaFetchResponse = {
  status: number;
  json(): Promise<unknown>;
};

export type TokenQuotaFetch = (
  url: string,
  init: { signal: AbortSignal },
) => Promise<TokenQuotaFetchResponse>;

export type TokenQuotaWakeKind =
  | "health"
  | "provider_not_ok"
  | "low_remaining"
  | "fingerprint_changed";

export type TokenQuotaWakeCondition = {
  kind: TokenQuotaWakeKind;
  /** Stable identity used for exactly-once notification (see notifiedKeys). */
  identity: string;
  summary: string;
  details: Record<string, unknown>;
};

export type TokenQuotaPollOutcome =
  | { allowed: false; reason: string }
  | {
      allowed: true;
      healthy: boolean;
      conditions: TokenQuotaWakeCondition[];
      fingerprint: string | null;
      /** Notified keys to persist (merged by the caller). */
      consumeKeys: string[];
      /** Notified keys that resolved and may be dropped. */
      resolveKeys: string[];
    };

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function parseObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The poller only contacts the allowlisted loopback plan-dash origin.
 * Any other stored externalRef (including public hosts) is never fetched.
 */
export function isAllowlistedTokenQuotaRef(value: string | null | undefined): boolean {
  const trimmed = readNonEmptyString(value);
  if (!trimmed) return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:") return false;
  const host = parsed.hostname.toLowerCase();
  // WHATWG URL keeps IPv6 brackets in hostname ("[::1]").
  if (host !== "127.0.0.1" && host !== "::1" && host !== "[::1]") return false;
  if (parsed.port !== "8787") return false;
  return true;
}

export function tokenQuotaPollBaseUrl(canonicalRef: string | null | undefined): string | null {
  const candidate = readNonEmptyString(canonicalRef) ?? TOKEN_QUOTA_MONITOR_ALLOWLISTED_ORIGIN;
  if (!isAllowlistedTokenQuotaRef(candidate)) return null;
  return candidate.replace(/\/+$/, "");
}

type QuotaModel = {
  id: string;
  available: boolean | null;
  disabled: boolean | null;
  degraded: boolean | null;
  roles: unknown;
  executorProvider: string | null;
};

/**
 * Routing fingerprint over sorted model id/available/disabled/degraded/
 * roles/executorProvider. remainingPercent and recentEvents are deliberately
 * excluded so ordinary consumption drift never wakes anyone.
 */
export function buildTokenQuotaRoutingFingerprint(models: unknown): string | null {
  if (!Array.isArray(models)) return null;
  const picked: QuotaModel[] = [];
  for (const entry of models) {
    const obj = parseObject(entry);
    const id = readNonEmptyString(obj.id);
    if (!id) continue;
    picked.push({
      id,
      available: typeof obj.available === "boolean" ? obj.available : null,
      disabled: typeof obj.disabled === "boolean" ? obj.disabled : null,
      degraded: typeof obj.degraded === "boolean" ? obj.degraded : null,
      roles: Array.isArray(obj.roles) ? [...obj.roles].sort() : null,
      executorProvider: readNonEmptyString(obj.executorProvider),
    });
  }
  picked.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return JSON.stringify(picked);
}

export function thresholdNotificationIdentity(input: {
  providerId: string;
  windowLabel: string;
  resetsAt: string | null;
}): string {
  return `threshold:${input.providerId}:${input.windowLabel}:${input.resetsAt ?? "no-reset"}`;
}

async function fetchJson(fetchImpl: TokenQuotaFetch, url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TOKEN_QUOTA_TOTAL_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`plan-dash returned HTTP ${response.status} for ${url}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * In-process cheap poll for a token-quota monitor. No Pi process is started
 * here; the caller decides whether the returned conditions warrant an agent
 * wake. Tests inject a mocked fetch; production passes global fetch.
 */
export async function pollTokenQuotaMonitor(input: {
  canonicalRef: string | null | undefined;
  fetchImpl: TokenQuotaFetch;
  notifiedKeys: string[];
  baselineFingerprint: string | null;
  thresholdPercent?: number;
}): Promise<TokenQuotaPollOutcome> {
  const base = tokenQuotaPollBaseUrl(input.canonicalRef);
  if (!base) {
    return { allowed: false, reason: "external_ref_not_allowlisted" };
  }
  const threshold = input.thresholdPercent ?? TOKEN_QUOTA_LOW_REMAINING_THRESHOLD_PERCENT;
  const notified = new Set(input.notifiedKeys);
  const conditions: TokenQuotaWakeCondition[] = [];
  const consumeKeys: string[] = [];
  const resolveKeys: string[] = [];

  const maybeNotify = (identity: string, condition: Omit<TokenQuotaWakeCondition, "identity">) => {
    if (notified.has(identity)) return;
    notified.add(identity);
    consumeKeys.push(identity);
    conditions.push({ ...condition, identity });
  };
  const maybeResolve = (identity: string) => {
    if (notified.has(identity)) {
      notified.delete(identity);
      resolveKeys.push(identity);
    }
  };

  let healthBody: Record<string, unknown>;
  let statusBody: Record<string, unknown>;
  try {
    const [healthRaw, statusRaw] = await Promise.all([
      fetchJson(input.fetchImpl, `${base}${TOKEN_QUOTA_HEALTHZ_PATH}`),
      fetchJson(input.fetchImpl, `${base}${TOKEN_QUOTA_STATUS_PATH}`),
    ]);
    healthBody = parseObject(healthRaw);
    statusBody = parseObject(statusRaw);
  } catch (error) {
    maybeNotify("health:unreachable", {
      kind: "health",
      summary: "plan-dash health check failed",
      details: { message: error instanceof Error ? error.message : String(error) },
    });
    return {
      allowed: true,
      healthy: false,
      conditions,
      fingerprint: input.baselineFingerprint,
      consumeKeys,
      resolveKeys,
    };
  }

  if (healthBody.ok !== true) {
    maybeNotify("health:unreachable", {
      kind: "health",
      summary: "plan-dash health check reported ok=false",
      details: { ok: healthBody.ok ?? null },
    });
  } else {
    maybeResolve("health:unreachable");
  }

  // A 200 response that omits usable quota data must not read as healthy:
  // flag the invalid shape under the existing health kind (no new
  // threshold) so the gap wakes the assignee instead of silently re-arming.
  const providersValue: unknown = statusBody.providers;
  const modelsValue: unknown = parseObject(statusBody.controlPlane).models;
  if (!Array.isArray(providersValue) || !Array.isArray(modelsValue)) {
    maybeNotify("status:invalid-shape", {
      kind: "health",
      summary: "plan-dash status response is missing quota data",
      details: {
        hasProviders: Array.isArray(providersValue),
        hasModels: Array.isArray(modelsValue),
      },
    });
  } else {
    maybeResolve("status:invalid-shape");
  }
  const providersRaw = Array.isArray(providersValue) ? providersValue : [];
  for (const providerRaw of providersRaw) {
    const provider = parseObject(providerRaw);
    const providerId =
      readNonEmptyString(provider.id) ?? readNonEmptyString(provider.name) ?? "unknown-provider";
    if (provider.ok === false) {
      maybeNotify(`provider:${providerId}:not-ok`, {
        kind: "provider_not_ok",
        summary: `provider ${providerId} reported ok=false`,
        details: { providerId, ok: false },
      });
    } else {
      maybeResolve(`provider:${providerId}:not-ok`);
    }
    const windowsRaw = Array.isArray(provider.windows) ? provider.windows : [];
    for (const windowRaw of windowsRaw) {
      const window = parseObject(windowRaw);
      const label = readNonEmptyString(window.label) ?? "default";
      const usedPercent = readNumber(window.usedPercent);
      const resetsAt = readNonEmptyString(window.resetsAt);
      const identity = thresholdNotificationIdentity({ providerId, windowLabel: label, resetsAt });
      if (usedPercent !== null && 100 - usedPercent < threshold) {
        maybeNotify(identity, {
          kind: "low_remaining",
          summary: `provider ${providerId} window ${label} below ${threshold}% remaining`,
          details: {
            providerId,
            windowLabel: label,
            usedPercent,
            remainingPercent: 100 - usedPercent,
            resetsAt,
            thresholdPercent: threshold,
          },
        });
      } else {
        maybeResolve(identity);
      }
    }
  }

  const models = parseObject(statusBody.controlPlane).models;
  const fingerprint = buildTokenQuotaRoutingFingerprint(models);
  let nextFingerprint = input.baselineFingerprint;
  if (fingerprint !== null) {
    if (input.baselineFingerprint === null) {
      nextFingerprint = fingerprint;
    } else if (fingerprint !== input.baselineFingerprint) {
      maybeNotify(`fingerprint:${fingerprint.length}:${hashShort(fingerprint)}`, {
        kind: "fingerprint_changed",
        summary: "plan-dash routing fingerprint changed",
        details: { previousLength: input.baselineFingerprint.length, nextLength: fingerprint.length },
      });
      nextFingerprint = fingerprint;
    }
  }

  return {
    allowed: true,
    healthy: conditions.length === 0,
    conditions,
    fingerprint: nextFingerprint,
    consumeKeys,
    resolveKeys,
  };
}

function hashShort(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Merge notified keys after a poll: add newly consumed identities, drop
 * resolved ones, and cap the list so a long-lived monitor cannot grow it
 * without bound.
 */
export function mergeNotifiedKeys(current: string[], consume: string[], resolve: string[]): string[] {
  const next = new Set(current);
  for (const key of resolve) next.delete(key);
  for (const key of consume) next.add(key);
  const list = [...next];
  return list.length > TOKEN_QUOTA_NOTIFIED_KEYS_CAP
    ? list.slice(list.length - TOKEN_QUOTA_NOTIFIED_KEYS_CAP)
    : list;
}
