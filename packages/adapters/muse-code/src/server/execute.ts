import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import {
  buildPaperclipEnv,
  buildRuntimeToolsEnv,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  joinPromptSections,
  parseObject,
  renderTemplate,
  runChildProcess,
  runningProcesses,
  selectPaperclipPromptSections,
  signalRunningProcess,
} from "@paperclipai/adapter-utils/server-utils";

export const MUSE_CODE_CANDIDATE_IDS = [
  "muse-code-wonder-1.0",
  "muse-code-spark-1.3",
] as const;
export const MUSE_CODE_MODEL_IDS = {
  "muse-code-wonder-1.0": "muse-wonder-1.0",
  "muse-code-spark-1.3": "muse-spark-1.3",
} as const;
export const MUSE_CODE_EXECUTOR_PROVIDER = "muse-code";
export const MUSE_CODE_QUOTA_PROVIDER = "meta-muse";
export const MUSE_CODE_QUOTA_POOL = "meta-muse-code";
const RUN_SCRATCH_MARKER = ".paperclip-run-scratch.json";
const CONTROL_API_TIMEOUT_MS = 10_000;
const DEFAULT_TIMEOUT_SEC = 900;
const MAX_TIMEOUT_SEC = 14_400;
const DEFAULT_GRACE_SEC = 15;
const MAX_GRACE_SEC = 120;

type Selection = {
  id: string;
  model: string;
  executorProvider: string;
  quotaProvider: string;
  quotaPool: string;
  costType: string;
};

type Reservation = { id: string };
type ControlEvent = {
  result: "success" | "provider_error" | "timeout";
  role: "implementation";
  durationMs: number;
  quotaProvider: typeof MUSE_CODE_QUOTA_PROVIDER;
  quotaPool: typeof MUSE_CODE_QUOTA_POOL;
  model?: string;
};

type RunningProcess = NonNullable<ReturnType<typeof runningProcesses.get>>;

export interface MuseCodeExecutorDependencies {
  fetchImpl?: typeof fetch;
  runChildProcessImpl?: typeof runChildProcess;
  getRunningProcess?: (runId: string) => RunningProcess | undefined;
  signalRunningProcessImpl?: typeof signalRunningProcess;
  now?: () => number;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function pathsOverlap(first: string, second: string): boolean {
  return isPathInside(first, second) || isPathInside(second, first);
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) return fallback;
  return Math.min(value, max);
}

function resolveWorkspace(ctx: AdapterExecutionContext): string {
  if (ctx.executionTarget?.kind === "remote") {
    throw new Error("Muse Code adapter supports only local execution targets.");
  }
  const contextWorkspace = stringValue(parseObject(ctx.context.paperclipWorkspace).cwd);
  const configured = stringValue(ctx.config.cwd) || stringValue(ctx.config.workspaceDir);
  const cwd = contextWorkspace || configured;
  if (!cwd || !path.isAbsolute(cwd)) {
    throw new Error("Muse Code requires an absolute Paperclip execution workspace.");
  }
  return cwd;
}

async function isGitRepositoryRoot(root: string): Promise<boolean> {
  const markerPath = path.join(root, ".git");
  let marker;
  try {
    marker = await fs.lstat(markerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error("Muse Code repository boundary could not be verified.");
  }

  let gitDir = markerPath;
  if (marker.isFile()) {
    let markerText: string;
    try {
      markerText = await fs.readFile(markerPath, "utf8");
    } catch {
      throw new Error("Muse Code repository boundary could not be verified.");
    }
    const match = markerText.match(/^gitdir:\s*(.+)\s*$/m);
    if (!match) return false;
    gitDir = path.resolve(root, match[1]!);
  } else if (!marker.isDirectory()) {
    return false;
  }

  try {
    const metadata = await fs.stat(gitDir);
    if (!metadata.isDirectory()) return false;
    await fs.access(path.join(gitDir, "HEAD"));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new Error("Muse Code repository boundary could not be verified.");
  }
}

async function workspaceAndRepositoryRoots(ctx: AdapterExecutionContext, workspaceRoot: string): Promise<string[]> {
  const roots = new Set<string>([workspaceRoot]);
  const hints = Array.isArray(ctx.context.paperclipWorkspaces)
    ? ctx.context.paperclipWorkspaces
    : [];
  for (const hintValue of hints) {
    const hint = parseObject(hintValue);
    const cwd = stringValue(hint.cwd);
    if (cwd && path.isAbsolute(cwd)) {
      try {
        roots.add(await fs.realpath(cwd));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  const repositories = new Set<string>();
  for (const root of roots) {
    let cursor = root;
    while (true) {
      if (await isGitRepositoryRoot(cursor)) repositories.add(cursor);
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  return [...new Set([...roots, ...repositories])];
}

async function validateScratchRoot(ctx: AdapterExecutionContext, workspace: string): Promise<string> {
  const contextScratch = parseObject(ctx.context.paperclipScratch);
  const contextDir = stringValue(contextScratch.dir);
  if (
    contextScratch.type !== "heartbeat_run" ||
    contextScratch.marker !== RUN_SCRATCH_MARKER ||
    !contextDir
  ) {
    throw new Error("Muse Code requires Paperclip's run-owned scratch directory.");
  }

  const [scratchRoot, workspaceRoot, tempRoot] = await Promise.all([
    fs.realpath(contextDir),
    fs.realpath(workspace),
    fs.realpath(os.tmpdir()),
  ]);
  const protectedRoots = await workspaceAndRepositoryRoots(ctx, workspaceRoot);
  if (
    !path.basename(scratchRoot).startsWith("paperclip-run-") ||
    !isPathInside(tempRoot, scratchRoot) ||
    protectedRoots.some((root) => pathsOverlap(scratchRoot, root))
  ) {
    throw new Error("Muse Code scratch storage must be private and outside the task workspace.");
  }

  const scratchStat = await fs.stat(scratchRoot);
  if (!scratchStat.isDirectory() || (scratchStat.mode & 0o777) !== 0o700) {
    throw new Error("Muse Code run scratch directory is not mode 0700.");
  }
  let marker: Record<string, unknown>;
  try {
    const markerPath = path.join(scratchRoot, RUN_SCRATCH_MARKER);
    const markerStat = await fs.lstat(markerPath);
    if (!markerStat.isFile() || (markerStat.mode & 0o777) !== 0o600) {
      throw new Error("invalid run scratch marker");
    }
    marker = parseObject(JSON.parse(await fs.readFile(markerPath, "utf8")));
  } catch {
    throw new Error("Muse Code run scratch ownership could not be verified.");
  }
  if (
    marker.version !== 1 ||
    marker.runId !== ctx.runId ||
    marker.agentId !== ctx.agent.id ||
    marker.companyId !== ctx.agent.companyId
  ) {
    throw new Error("Muse Code run scratch ownership did not match this run.");
  }
  return scratchRoot;
}

function buildTaskPrompt(ctx: AdapterExecutionContext): string {
  const template = stringValue(ctx.config.promptTemplate) || DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE;
  const promptContext = ctx.context;
  const { taskContextNote, wakePrompt } = selectPaperclipPromptSections(promptContext, {
    includeCommunicationGuidance: true,
    includeExecutionContract: true,
    resumedSession: false,
  });
  const taskId = stringValue(promptContext.taskId) || stringValue(promptContext.issueId);
  const renderedInstructions = renderTemplate(template, {
    agent: ctx.agent,
    agentId: ctx.agent.id,
    agentName: ctx.agent.name,
    companyId: ctx.agent.companyId,
    run: { id: ctx.runId },
    runId: ctx.runId,
    context: promptContext,
    taskId,
    taskTitle: stringValue(promptContext.taskTitle),
    taskBody: stringValue(promptContext.taskBody),
  });
  const prompt = joinPromptSections([
    wakePrompt,
    stringValue(promptContext.paperclipSessionHandoffMarkdown),
    taskContextNote,
    renderedInstructions,
  ]);
  if (!prompt) throw new Error("Muse Code received no Paperclip task context.");
  return prompt;
}

function resolveControlPlaneUrl(config: Record<string, unknown>): string {
  const candidate =
    stringValue(config.controlPlaneUrl) ||
    process.env.QUOTA_CONTROL_URL ||
    "http://127.0.0.1:8787";
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("Muse Code quota-control URL is invalid.");
  }
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopbackHosts.has(url.hostname))) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error("Muse Code quota-control URL must be loopback HTTP or HTTPS without credentials or a path.");
  }
  return url.origin;
}

async function controlRequestJson(input: {
  baseUrl: string;
  route: string;
  method: "POST" | "DELETE";
  body?: Record<string, unknown>;
  token: string;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CONTROL_API_TIMEOUT_MS);
  const abortFromRun = () => controller.abort();
  input.signal?.addEventListener("abort", abortFromRun, { once: true });
  if (input.signal?.aborted) controller.abort();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "X-Quota-Control": "1",
  };
  if (input.token) headers.Authorization = `Bearer ${input.token}`;
  try {
    const response = await input.fetchImpl(new URL(input.route, `${input.baseUrl}/`), {
      method: input.method,
      headers,
      ...(input.body ? { body: JSON.stringify(input.body) } : {}),
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error("Quota control request failed.");
    if (response.status === 204) return {};
    try {
      return parseObject(await response.json());
    } catch {
      throw new Error("Quota control response was invalid.");
    }
  } catch {
    throw new Error("Quota control request failed.");
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", abortFromRun);
  }
}

function validateSelection(value: unknown): Selection {
  const selected = parseObject(value);
  const expectedModel = typeof selected.id === "string"
    ? MUSE_CODE_MODEL_IDS[selected.id as keyof typeof MUSE_CODE_MODEL_IDS]
    : undefined;
  if (
    !expectedModel ||
    selected.model !== expectedModel ||
    selected.executorProvider !== MUSE_CODE_EXECUTOR_PROVIDER ||
    selected.quotaProvider !== MUSE_CODE_QUOTA_PROVIDER ||
    selected.quotaPool !== MUSE_CODE_QUOTA_POOL ||
    selected.costType !== "subscription"
  ) {
    throw new Error("Quota selection did not match the configured Muse Code subscription.");
  }
  return selected as Selection;
}

async function createPrivatePromptFile(scratchRoot: string, prompt: string): Promise<{ directory: string; file: string }> {
  const directory = await fs.mkdtemp(path.join(scratchRoot, "muse-code-"));
  try {
    await fs.chmod(directory, 0o700);
    const file = path.join(directory, "prompt.md");
    const handle = await fs.open(file, "wx", 0o600);
    try {
      await handle.writeFile(prompt, "utf8");
    } finally {
      await handle.close();
    }
    await fs.chmod(file, 0o600);
    const stat = await fs.stat(file);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
      throw new Error("Muse Code prompt file is not a private regular file.");
    }
    return { directory, file };
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

function selectedReservation(value: unknown): Reservation | null {
  const reservation = parseObject(value);
  return typeof reservation.id === "string" && reservation.id.trim()
    ? { id: reservation.id }
    : null;
}

function buildChildEnvironment(ctx: AdapterExecutionContext, scratchDir: string): Record<string, string> {
  const taskId = stringValue(ctx.context.taskId) || stringValue(ctx.context.issueId);
  const wakeReason = stringValue(ctx.context.wakeReason) || stringValue(parseObject(ctx.context.paperclipWake).reason);
  const env: Record<string, string> = {
    ...buildPaperclipEnv(ctx.agent),
    ...buildRuntimeToolsEnv(ctx.runtimeTools),
    PAPERCLIP_RUN_ID: ctx.runId,
    PAPERCLIP_SCRATCH_DIR: scratchDir,
    PAPERCLIP_RUN_SCRATCH_DIR: scratchDir,
    PAPERCLIP_TASK_SCRATCH_DIR: scratchDir,
    // Muse Code must use its saved Meta account login, never a PAYG API key
    // inherited from the Paperclip server environment.
    META_API_KEY: "",
    // The plan-quota credential is for adapter-side HTTP only.
    QUOTA_CONTROL_TOKEN: "",
    DASHBOARD_TOKEN: "",
    TMPDIR: scratchDir,
    TEMP: scratchDir,
    TMP: scratchDir,
  };
  if (taskId) env.PAPERCLIP_TASK_ID = taskId;
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;
  if (ctx.authToken) env.PAPERCLIP_API_KEY = ctx.authToken;
  delete env.PAPERCLIP_WAKE_PAYLOAD_JSON;
  return env;
}

function resultFor(input: {
  selection: Selection;
  status: "succeeded" | "failed" | "timed_out" | "cancelled";
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
}): AdapterExecutionResult {
  const errorMessage = input.status === "succeeded"
    ? null
    : input.status === "timed_out"
      ? "Muse Code execution timed out."
      : input.status === "cancelled"
        ? "Muse Code execution was cancelled."
        : "Muse Code execution failed; raw output was withheld.";
  return {
    exitCode: input.exitCode,
    signal: input.signal,
    timedOut: input.timedOut,
    errorMessage,
    provider: "meta",
    model: input.selection.model,
    billingType: "subscription",
    summary: input.status === "succeeded"
      ? `Muse Code completed the assigned task with ${input.selection.model}.`
      : errorMessage,
    resultJson: {
      adapter: "muse_code",
      status: input.status,
      exitCode: input.exitCode,
      signal: input.signal,
      timedOut: input.timedOut,
      durationMs: input.durationMs,
      candidateId: input.selection.id,
      model: input.selection.model,
      provider: "meta",
      billingType: "subscription",
    },
  };
}

export function createMuseCodeExecutor(dependencies: MuseCodeExecutorDependencies = {}) {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const runProcess = dependencies.runChildProcessImpl ?? runChildProcess;
  const getRunningProcess = dependencies.getRunningProcess ?? ((runId) => runningProcesses.get(runId));
  const signalProcess = dependencies.signalRunningProcessImpl ?? signalRunningProcess;
  const now = dependencies.now ?? (() => performance.now());

  return async function executeMuseCode(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
    if (ctx.signal?.aborted) throw new Error("Muse Code execution was cancelled before selection.");
    const workspace = resolveWorkspace(ctx);
    const scratchRoot = await validateScratchRoot(ctx, workspace);
    const prompt = buildTaskPrompt(ctx);
    const baseUrl = resolveControlPlaneUrl(ctx.config);
    const token = process.env.QUOTA_CONTROL_TOKEN || process.env.DASHBOARD_TOKEN || "";
    const timeoutSec = boundedNumber(ctx.config.timeoutSec, DEFAULT_TIMEOUT_SEC, 1, MAX_TIMEOUT_SEC);
    const graceSec = boundedNumber(ctx.config.graceSec, DEFAULT_GRACE_SEC, 1, MAX_GRACE_SEC);

    await ctx.onCancellationReady?.();
    if (ctx.signal?.aborted) throw new Error("Muse Code execution was cancelled before selection.");

    let reservation: Reservation | null = null;
    let selection: Selection | null = null;
    let promptDirectory: string | null = null;
    let result: AdapterExecutionResult | null = null;
    let event: ControlEvent | null = null;
    let selectionMismatch = false;
    let finalStatus: "succeeded" | "failed" | "timed_out" | "cancelled" = "failed";
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    let timedOut = false;
    let durationMs = 0;
    let thrownError: Error | null = null;
    let processStarted = false;
    let cancellationRequested = false;
    let terminationStarted = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const cancelRunningProcess = () => {
      cancellationRequested = true;
      if (terminationStarted) return;
      const running = getRunningProcess(ctx.runId);
      if (!running) return;
      terminationStarted = true;
      signalProcess(running, "SIGTERM");
      killTimer = setTimeout(() => {
        const current = getRunningProcess(ctx.runId);
        if (current) signalProcess(current, "SIGKILL");
      }, Math.max(1, graceSec) * 1000);
      killTimer.unref?.();
    };
    const onAbort = () => cancelRunningProcess();
    ctx.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const selectionResponse = await controlRequestJson({
        baseUrl,
        route: "/v1/select",
        method: "POST",
        token,
        fetchImpl,
        signal: ctx.signal,
        body: {
          role: "implementation",
          candidates: [...MUSE_CODE_CANDIDATE_IDS],
          allowManual: false,
          reserve: {
            weight: "medium",
            minutes: 30,
            owner: `paperclip:muse-code:${ctx.runId}`,
          },
        },
      });
      reservation = selectedReservation(selectionResponse.reservation);
      if (!reservation) {
        selectionMismatch = true;
        throw new Error("Quota control did not create a Muse Code reservation.");
      }
      try {
        selection = validateSelection(selectionResponse.selected);
      } catch {
        selectionMismatch = true;
        throw new Error("Quota selection did not match the configured Muse Code subscription.");
      }
      if (ctx.signal?.aborted) throw new Error("Muse Code execution was cancelled before launch.");

      const promptFile = await createPrivatePromptFile(scratchRoot, prompt);
      promptDirectory = promptFile.directory;
      if (ctx.signal?.aborted) throw new Error("Muse Code execution was cancelled before launch.");
      const args = [
        "exec",
        "--provider", "meta",
        "--model", selection.model,
        "--prompt-file", promptFile.file,
        "--approval-mode", "on-request",
        "--sandbox-network", "proxy-only",
        "--no-session-log",
      ];
      const childEnv = buildChildEnvironment(ctx, scratchRoot);
      const startedAt = now();
      try {
        const processResult = await runProcess(ctx.runId, "muse", args, {
          cwd: workspace,
          env: childEnv,
          timeoutSec,
          graceSec,
          onLog: async () => {},
          onSpawn: async (meta) => {
            processStarted = true;
            try {
              await ctx.onSpawn?.(meta);
            } finally {
              if (ctx.signal?.aborted || cancellationRequested) cancelRunningProcess();
            }
          },
        });
        durationMs = Math.max(0, Math.round(now() - startedAt));
        exitCode = processResult.exitCode;
        exitSignal = processResult.signal;
        timedOut = processResult.timedOut;
        if (processResult.timedOut) {
          finalStatus = "timed_out";
        } else if ((ctx.signal?.aborted || cancellationRequested) && !(processResult.exitCode === 0 && processResult.signal === null)) {
          finalStatus = "cancelled";
        } else if (processResult.exitCode === 0 && processResult.signal === null) {
          finalStatus = "succeeded";
        } else {
          finalStatus = "failed";
        }
      } catch {
        durationMs = Math.max(0, Math.round(now() - startedAt));
        finalStatus = ctx.signal?.aborted || cancellationRequested ? "cancelled" : "failed";
      } finally {
        ctx.signal?.removeEventListener("abort", onAbort);
        if (killTimer) clearTimeout(killTimer);
        killTimer = null;
      }

      result = resultFor({
        selection,
        status: finalStatus,
        exitCode,
        signal: exitSignal,
        timedOut,
        durationMs,
      });
      event = {
        result: finalStatus === "succeeded"
          ? "success"
          : finalStatus === "timed_out"
            ? "timeout"
            : "provider_error",
        role: "implementation",
        durationMs,
        quotaProvider: MUSE_CODE_QUOTA_PROVIDER,
        quotaPool: MUSE_CODE_QUOTA_POOL,
        ...((processStarted && finalStatus !== "cancelled") ? { model: selection.model } : {}),
      };
    } catch (error) {
      thrownError = error instanceof Error ? error : new Error("Muse Code adapter failed.");
      if (selectionMismatch) {
        event = {
          result: "provider_error",
          role: "implementation",
          durationMs: 0,
          quotaProvider: MUSE_CODE_QUOTA_PROVIDER,
          quotaPool: MUSE_CODE_QUOTA_POOL,
        };
      } else if (!event && (selection || reservation)) {
        event = {
          result: "provider_error",
          role: "implementation",
          durationMs,
          quotaProvider: MUSE_CODE_QUOTA_PROVIDER,
          quotaPool: MUSE_CODE_QUOTA_POOL,
          ...((processStarted && selection) ? { model: selection.model } : {}),
        };
      }
    } finally {
      ctx.signal?.removeEventListener("abort", onAbort);
      if (killTimer) clearTimeout(killTimer);
      if (promptDirectory) {
        try {
          await fs.rm(promptDirectory, { recursive: true, force: true });
        } catch {
          await ctx.onLog("stderr", "[muse-code] private prompt cleanup failed.\n").catch(() => undefined);
        }
      }
      if (reservation) {
        try {
          await controlRequestJson({
            baseUrl,
            route: `/v1/reservations/${encodeURIComponent(reservation.id)}`,
            method: "DELETE",
            token,
            fetchImpl,
          });
        } catch {
          await ctx.onLog("stderr", "[muse-code] reservation release failed.\n").catch(() => undefined);
        }
      }
      if (event) {
        try {
          await controlRequestJson({
            baseUrl,
            route: "/v1/events",
            method: "POST",
            token,
            fetchImpl,
            body: event,
          });
        } catch {
          await ctx.onLog("stderr", "[muse-code] quota event report failed.\n").catch(() => undefined);
        }
      }
      const status = result ? String(parseObject(result.resultJson).status) : "failed";
      const logExit = exitCode === null ? "null" : String(exitCode);
      await ctx.onLog("stdout", `[muse-code] status=${status} exitCode=${logExit} durationMs=${durationMs}\n`).catch(() => undefined);
    }

    if (thrownError) throw thrownError;
    if (!result) throw new Error("Muse Code adapter produced no execution result.");
    return result;
  };
}

export const execute = createMuseCodeExecutor();
