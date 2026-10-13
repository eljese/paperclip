import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runningProcesses } from "@paperclipai/adapter-utils/server-utils";
import { createMuseCodeExecutor, MUSE_CODE_CANDIDATE_IDS } from "./execute.js";

const ISSUE_TEXT = "MUSE_PROMPT_SENTINEL: implement the assigned task";
const TASK_TITLE = "MUSE_TASK_TITLE_SENTINEL: adapter task";
const WAKE_COMMENT_TEXT = "MUSE_WAKE_COMMENT_SENTINEL: use the latest instruction";
const RAW_OUTPUT = "MUSE_OUTPUT_SENTINEL: private tool output";
const DASH_MARKER = "dash-marker-value";
const PAPERCLIP_MARKER = "paperclip-marker-value";
const CANDIDATE_IDS = [...MUSE_CODE_CANDIDATE_IDS];

const selected = {
  id: "muse-code-wonder-1.0",
  model: "muse-wonder-1.0",
  executorProvider: "muse-code",
  quotaProvider: "meta-muse",
  quotaPool: "meta-muse-code",
  costType: "subscription",
};

let tempRoot: string;
let workspace: string;
let runScratch: string;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeContext(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-muse-1",
    agent: {
      id: "agent-1",
      name: "Muse engineer",
      companyId: "company-1",
      adapterType: "muse-code",
      adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {
      cwd: workspace,
      controlPlaneUrl: "http://127.0.0.1:8787",
      timeoutSec: 30,
      graceSec: 1,
    },
    context: {
      taskId: "issue-1",
      taskTitle: TASK_TITLE,
      paperclipTaskMarkdownAssignment: `## Task\n\n${ISSUE_TEXT}`,
      paperclipWake: {
        reason: "issue_assigned",
        issue: { id: "issue-1", identifier: "PAP-1", title: TASK_TITLE, description: ISSUE_TEXT, status: "in_progress" },
        comments: [{ id: "comment-1", body: WAKE_COMMENT_TEXT, createdAt: "2026-10-13T00:00:00.000Z", authorType: "user", authorId: "user-1" }],
      },
      paperclipScratch: { type: "heartbeat_run", dir: runScratch, cleanupPolicy: "terminal_run", marker: ".paperclip-run-scratch.json" },
    },
    executionTarget: { kind: "local" },
    onLog: vi.fn(async () => {}),
    onSpawn: vi.fn(async () => {}),
    onCancellationReady: vi.fn(async () => {}),
    authToken: PAPERCLIP_MARKER,
    ...overrides,
  } as any;
}

function makeFetch(selection = selected) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/v1/select")) {
      return jsonResponse({
        selected: selection,
        reservation: { id: "reservation-1", model: selection.model },
      });
    }
    if (url.endsWith("/v1/events")) return jsonResponse({ accepted: true }, 202);
    if (url.endsWith("/v1/reservations/reservation-1")) {
      return jsonResponse({ released: true, id: "reservation-1" });
    }
    throw new Error(`unexpected URL ${url}`);
  });
  return { fetchImpl, calls };
}

function successfulProcess(runChildProcessImpl: any, options: { code?: number | null; signal?: string | null; timedOut?: boolean } = {}) {
  runChildProcessImpl.mockImplementation(async (_runId: string, _command: string, _args: string[], processOptions: any) => {
    await processOptions.onSpawn?.({ pid: 1234, processGroupId: null, startedAt: new Date(0).toISOString() });
    return {
      exitCode: options.code === undefined ? 0 : options.code,
      signal: options.signal ?? null,
      timedOut: options.timedOut ?? false,
      stdout: RAW_OUTPUT,
      stderr: RAW_OUTPUT,
      pid: 1234,
      startedAt: new Date(0).toISOString(),
    };
  });
}

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "paperclip-muse-test-"));
  await fs.chmod(tempRoot, 0o700);
  workspace = path.join(tempRoot, "workspace");
  await fs.mkdir(workspace, { mode: 0o700 });
  runScratch = path.join(tempRoot, "paperclip-run-run-muse-1");
  await fs.mkdir(runScratch, { mode: 0o700 });
  await fs.writeFile(
    path.join(runScratch, ".paperclip-run-scratch.json"),
    JSON.stringify({ version: 1, companyId: "company-1", agentId: "agent-1", runId: "run-muse-1", createdAt: new Date(0).toISOString() }),
    { mode: 0o600 },
  );
  vi.stubEnv("QUOTA_CONTROL_TOKEN", DASH_MARKER);
  vi.stubEnv("DASHBOARD_TOKEN", "");
});

afterEach(async () => {
  runningProcesses.delete("run-muse-1");
  vi.unstubAllEnvs();
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("Muse Code external adapter", () => {
  it.each([
    { candidateId: "muse-code-wonder-1.0", model: "muse-wonder-1.0" },
    { candidateId: "muse-code-spark-1.3", model: "muse-spark-1.3" },
  ])("selects the exact $candidateId subscription route and transports task context in a private file", async ({ candidateId, model }) => {
    const routeSelection = { ...selected, id: candidateId, model };
    const { fetchImpl, calls } = makeFetch(routeSelection);
    const processMock = vi.fn();
    let promptDuringRun = "";
    let promptFileMode = 0;
    let promptDirectoryMode = 0;
    processMock.mockImplementation(async (_runId: string, _command: string, args: string[], options: any) => {
      await options.onSpawn?.({ pid: 1234, processGroupId: null, startedAt: new Date(0).toISOString() });
      const promptFilePath = args[args.indexOf("--prompt-file") + 1];
      const [promptFileStat, promptDirectoryStat] = await Promise.all([
        fs.stat(promptFilePath),
        fs.stat(path.dirname(promptFilePath)),
      ]);
      promptDuringRun = await fs.readFile(promptFilePath, "utf8");
      promptFileMode = promptFileStat.mode & 0o777;
      promptDirectoryMode = promptDirectoryStat.mode & 0o777;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: RAW_OUTPUT,
        stderr: RAW_OUTPUT,
        pid: 1234,
        startedAt: new Date(0).toISOString(),
      };
    });
    const ctx = makeContext();
    expect(ctx.config).not.toHaveProperty("env");
    const execute = createMuseCodeExecutor({ fetchImpl: fetchImpl as any, runChildProcessImpl: processMock as any });

    const result = await execute(ctx);

    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/v1/select",
      "/v1/reservations/reservation-1",
      "/v1/events",
    ]);
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[1]!.init.method).toBe("DELETE");
    expect(calls[2]!.init.method).toBe("POST");
    const select = calls.find((call) => call.url.endsWith("/v1/select"))!;
    const selectBody = JSON.parse(String(select.init.body));
    expect(selectBody.candidates).toEqual(CANDIDATE_IDS);
    expect(selectBody.allowManual).toBe(false);
    expect(selectBody).not.toHaveProperty("prompt");
    expect(JSON.stringify(selectBody)).not.toContain(ISSUE_TEXT);
    expect(JSON.stringify(selectBody)).not.toContain(TASK_TITLE);
    expect(JSON.stringify(selectBody)).not.toContain(WAKE_COMMENT_TEXT);
    expect(select.init.headers).toMatchObject({
      Authorization: `Bearer ${DASH_MARKER}`,
      "X-Quota-Control": "1",
    });

    expect(processMock).toHaveBeenCalledOnce();
    const [runId, command, args, options] = processMock.mock.calls[0]!;
    expect(runId).toBe("run-muse-1");
    expect(command).toBe("muse");
    expect(args).toContain("--provider");
    expect(args.slice(args.indexOf("--provider") + 1, args.indexOf("--provider") + 2)).toEqual(["meta"]);
    expect(args.slice(args.indexOf("--model") + 1, args.indexOf("--model") + 2)).toEqual([model]);
    expect(args.slice(args.indexOf("--prompt-file") + 1, args.indexOf("--prompt-file") + 2)).toEqual([expect.any(String)]);
    expect(args).toContain("--approval-mode");
    expect(args).toContain("on-request");
    expect(args).toContain("--sandbox-network");
    expect(args).toContain("proxy-only");
    expect(args).toContain("--no-session-log");
    expect(args).not.toContain("--yolo");
    expect(args).not.toContain("--disable-sandbox");
    expect(args).not.toContain("--disable-approval");
    expect(args).not.toContain("--contributor-mode");

    const promptFile = args[args.indexOf("--prompt-file") + 1];
    expect(promptFileMode).toBe(0o600);
    expect(promptDirectoryMode).toBe(0o700);
    expect(path.relative(runScratch, path.dirname(promptFile)).startsWith(".." )).toBe(false);
    expect(promptDuringRun).toContain(ISSUE_TEXT);
    expect(promptDuringRun).toContain(TASK_TITLE);
    expect(promptDuringRun).toContain(WAKE_COMMENT_TEXT);
    expect(promptDuringRun).toContain("## Task");
    expect(JSON.stringify(args)).not.toContain(ISSUE_TEXT);
    expect(JSON.stringify(args)).not.toContain(TASK_TITLE);
    expect(JSON.stringify(args)).not.toContain(WAKE_COMMENT_TEXT);
    expect(JSON.stringify(options.env)).not.toContain(ISSUE_TEXT);
    expect(JSON.stringify(options.env)).not.toContain(TASK_TITLE);
    expect(JSON.stringify(options.env)).not.toContain(WAKE_COMMENT_TEXT);
    expect(options.cwd).toBe(workspace);
    expect(options.env.TMPDIR).toBe(runScratch);
    expect(options.env.PAPERCLIP_API_KEY).toBe(PAPERCLIP_MARKER);
    expect(options.env.META_API_KEY).toBe("");
    expect(options.env.QUOTA_CONTROL_TOKEN).toBe("");
    expect(options.env.DASHBOARD_TOKEN).toBe("");
    expect(JSON.stringify(options.env)).not.toContain(DASH_MARKER);
    expect(options.onLog).toBeTypeOf("function");
    await options.onLog("stdout", RAW_OUTPUT);
    expect(ctx.onLog.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n")).not.toContain(RAW_OUTPUT);
    expect(JSON.stringify(result)).not.toContain(ISSUE_TEXT);
    expect(JSON.stringify(result)).not.toContain(RAW_OUTPUT);
    expect(JSON.stringify(result)).not.toContain(PAPERCLIP_MARKER);
    expect(JSON.stringify(result)).not.toContain(DASH_MARKER);
    for (const sensitiveText of [ISSUE_TEXT, TASK_TITLE, WAKE_COMMENT_TEXT, RAW_OUTPUT]) {
      expect(JSON.stringify(result)).not.toContain(sensitiveText);
      expect(JSON.stringify(ctx.onLog.mock.calls)).not.toContain(sensitiveText);
    }
    await expect(fs.access(promptFile)).rejects.toThrow();

    const event = calls.find((call) => call.url.endsWith("/v1/events"))!;
    const eventBody = JSON.parse(String(event.init.body));
    expect(eventBody).toMatchObject({ result: "success", role: "implementation", model, quotaProvider: "meta-muse", quotaPool: "meta-muse-code" });
    expect(eventBody.durationMs).toEqual(expect.any(Number));
    expect(JSON.stringify(eventBody)).not.toContain(ISSUE_TEXT);
    expect(JSON.stringify(eventBody)).not.toContain(TASK_TITLE);
    expect(JSON.stringify(eventBody)).not.toContain(WAKE_COMMENT_TEXT);
    expect(JSON.stringify(eventBody)).not.toContain(RAW_OUTPUT);
    expect(calls.some((call) => call.url.endsWith("/v1/reservations/reservation-1"))).toBe(true);
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, provider: "meta", model, billingType: "subscription" });
    expect(result.summary).toBe(`Muse Code completed the assigned task with ${model}.`);
  });

  it("skips missing advisory workspaces while still validating run scratch", async () => {
    const { fetchImpl } = makeFetch();
    const processMock = vi.fn();
    successfulProcess(processMock);
    const ctx = makeContext();
    ctx.context.paperclipWorkspaces = [{ cwd: path.join(tempRoot, "missing-advisory-workspace") }];
    const execute = createMuseCodeExecutor({ fetchImpl: fetchImpl as any, runChildProcessImpl: processMock as any });

    const result = await execute(ctx);

    expect(result.exitCode).toBe(0);
    expect(processMock).toHaveBeenCalledOnce();
    expect(processMock.mock.calls[0]![3].env.TMPDIR).toBe(runScratch);

    await fs.writeFile(
      path.join(runScratch, ".paperclip-run-scratch.json"),
      JSON.stringify({ version: 1, companyId: "company-1", agentId: "other-agent", runId: "run-muse-1" }),
      { mode: 0o600 },
    );
    const secondProcessMock = vi.fn();
    const secondExecute = createMuseCodeExecutor({ fetchImpl: makeFetch().fetchImpl as any, runChildProcessImpl: secondProcessMock as any });

    await expect(secondExecute(ctx)).rejects.toThrow(/ownership/i);
    expect(secondProcessMock).not.toHaveBeenCalled();
  });

  it("fails closed on non-ENOENT advisory workspace errors", async () => {
    const deniedWorkspace = path.join(tempRoot, "permission-denied-advisory-workspace");
    const originalRealpath = fs.realpath.bind(fs);
    const realpathSpy = vi.spyOn(fs, "realpath").mockImplementation(async (pathValue: any) => {
      if (String(pathValue) === deniedWorkspace) {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }
      return originalRealpath(pathValue);
    });
    try {
      const ctx = makeContext();
      ctx.context.paperclipWorkspaces = [{ cwd: deniedWorkspace }];
      const processMock = vi.fn();
      const execute = createMuseCodeExecutor({ fetchImpl: makeFetch().fetchImpl as any, runChildProcessImpl: processMock as any });

      await expect(execute(ctx)).rejects.toMatchObject({ code: "EACCES" });
      expect(processMock).not.toHaveBeenCalled();
    } finally {
      realpathSpy.mockRestore();
    }
  });

  it.each([
    { field: "executorProvider", value: "pi" },
    { field: "quotaProvider", value: "meta-api" },
    { field: "quotaPool", value: "meta-api" },
    { field: "costType", value: "metered_api" },
  ])("rejects a selected $field mismatch before spawning and releases the reservation", async ({ field, value }) => {
    const { fetchImpl, calls } = makeFetch({ ...selected, [field]: value });
    const processMock = vi.fn();
    const execute = createMuseCodeExecutor({ fetchImpl: fetchImpl as any, runChildProcessImpl: processMock as any });

    await expect(execute(makeContext())).rejects.toThrow(/selection/i);

    expect(processMock).not.toHaveBeenCalled();
    expect(calls.some((call) => call.url.endsWith("/v1/reservations/reservation-1"))).toBe(true);
    const event = calls.find((call) => call.url.endsWith("/v1/events"))!;
    const eventBody = JSON.parse(String(event.init.body));
    expect(eventBody).toMatchObject({ result: "provider_error", role: "implementation", quotaProvider: "meta-muse", quotaPool: "meta-muse-code" });
    expect(eventBody).not.toHaveProperty("model");
  });

  it("does not opt in to a manual-only model when selection is denied", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, init });
      return jsonResponse({ error: "no eligible model" }, 409);
    });
    const processMock = vi.fn();
    const execute = createMuseCodeExecutor({ fetchImpl: fetchImpl as any, runChildProcessImpl: processMock as any });

    await expect(execute(makeContext())).rejects.toThrow(/quota control/i);

    const requestBody = JSON.parse(String(calls[0]!.init.body));
    expect(requestBody).toMatchObject({ role: "implementation", candidates: CANDIDATE_IDS, allowManual: false });
    expect(requestBody).not.toHaveProperty("allowManual", true);
    expect(processMock).not.toHaveBeenCalled();
    expect(calls.some((call) => call.url.endsWith("/v1/events"))).toBe(false);
  });

  it("records a provider failure and releases the reservation without persisting output", async () => {
    const { fetchImpl, calls } = makeFetch();
    const processMock = vi.fn();
    successfulProcess(processMock, { code: 17 });
    const execute = createMuseCodeExecutor({ fetchImpl: fetchImpl as any, runChildProcessImpl: processMock as any });

    const result = await execute(makeContext());

    expect(result.errorMessage).toMatch(/raw output was withheld/i);
    const event = calls.find((call) => call.url.endsWith("/v1/events"))!;
    expect(JSON.parse(String(event.init.body))).toMatchObject({ result: "provider_error", model: selected.model, durationMs: expect.any(Number) });
    expect(calls.some((call) => call.url.endsWith("/v1/reservations/reservation-1"))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(RAW_OUTPUT);
  });

  it("records a timeout and releases the reservation without persisting output", async () => {
    const { fetchImpl, calls } = makeFetch();
    const processMock = vi.fn();
    successfulProcess(processMock, { code: null, signal: "SIGTERM", timedOut: true });
    const execute = createMuseCodeExecutor({ fetchImpl: fetchImpl as any, runChildProcessImpl: processMock as any });

    const result = await execute(makeContext());

    expect(result.timedOut).toBe(true);
    const event = calls.find((call) => call.url.endsWith("/v1/events"))!;
    expect(JSON.parse(String(event.init.body))).toMatchObject({ result: "timeout", model: selected.model, durationMs: expect.any(Number) });
    expect(calls.some((call) => call.url.endsWith("/v1/reservations/reservation-1"))).toBe(true);
    expect(JSON.stringify(result)).not.toContain(RAW_OUTPUT);
  });

  it("terminates the child on cancellation, records a content-free failure, and removes the prompt file", async () => {
    const { fetchImpl, calls } = makeFetch();
    const controller = new AbortController();
    let started!: () => void;
    const isStarted = new Promise<void>((resolve) => { started = resolve; });
    const signals: string[] = [];
    const processMock = vi.fn(async (runId: string, _command: string, _args: string[], processOptions: any) => {
      const child = {
        pid: 1234,
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        kill(signal: NodeJS.Signals) {
          signals.push(signal);
          this.signalCode = signal;
          processOptions.onLog("stdout", RAW_OUTPUT);
          return true;
        },
      };
      runningProcesses.set(runId, { child, processGroupId: null, graceSec: 1 } as any);
      await processOptions.onSpawn?.({ pid: child.pid, processGroupId: null, startedAt: new Date(0).toISOString() });
      started();
      return await new Promise((resolve) => {
        child.kill = ((signal: NodeJS.Signals) => {
          signals.push(signal);
          child.signalCode = signal;
          resolve({ exitCode: null, signal, timedOut: false, stdout: RAW_OUTPUT, stderr: RAW_OUTPUT, pid: child.pid, startedAt: new Date(0).toISOString() });
          return true;
        }) as typeof child.kill;
      });
    });
    const execute = createMuseCodeExecutor({ fetchImpl: fetchImpl as any, runChildProcessImpl: processMock as any });
    const ctx = makeContext({ signal: controller.signal });
    const running = execute(ctx);
    await isStarted;
    const args = processMock.mock.calls[0]![2] as string[];
    const promptFile = args[args.indexOf("--prompt-file") + 1];
    expect((await fs.stat(promptFile)).isFile()).toBe(true);
    controller.abort();
    const result = await running;

    expect(signals).toContain("SIGTERM");
    expect(result.errorMessage).toMatch(/cancel/i);
    expect(JSON.stringify(result)).not.toContain(ISSUE_TEXT);
    expect(JSON.stringify(result)).not.toContain(RAW_OUTPUT);
    expect(JSON.stringify(result)).not.toContain(DASH_MARKER);
    expect(JSON.stringify(ctx.onLog.mock.calls)).not.toContain(ISSUE_TEXT);
    expect(JSON.stringify(ctx.onLog.mock.calls)).not.toContain(RAW_OUTPUT);
    await expect(fs.access(promptFile)).rejects.toThrow();

    const event = calls.find((call) => call.url.endsWith("/v1/events"))!;
    const eventBody = JSON.parse(String(event.init.body));
    expect(eventBody).toMatchObject({ result: "provider_error", role: "implementation", quotaProvider: "meta-muse", quotaPool: "meta-muse-code" });
    expect(eventBody).not.toHaveProperty("model");
    expect(calls.some((call) => call.url.endsWith("/v1/reservations/reservation-1"))).toBe(true);
  });

  it("terminates the child when a cancellation races a rejected host onSpawn hook", async () => {
    const { fetchImpl, calls } = makeFetch();
    const controller = new AbortController();
    const signals: string[] = [];
    const processMock = vi.fn(async (runId: string, _command: string, _args: string[], processOptions: any) => {
      const child = {
        pid: 1234,
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        kill: (_signal: NodeJS.Signals) => true,
      };
      let resolveDone!: (value: unknown) => void;
      const done = new Promise((resolve) => { resolveDone = resolve; });
      child.kill = ((signal: NodeJS.Signals) => {
        signals.push(signal);
        child.signalCode = signal;
        resolveDone({ exitCode: null, signal, timedOut: false, stdout: RAW_OUTPUT, stderr: RAW_OUTPUT, pid: child.pid, startedAt: new Date(0).toISOString() });
        return true;
      }) as typeof child.kill;
      // Mirror runChildProcess ordering: the host hook runs before the child is
      // registered, and this host hook aborts the run and then rejects.
      const spawnHook = processOptions.onSpawn?.({ pid: child.pid, processGroupId: null, startedAt: new Date(0).toISOString() });
      runningProcesses.set(runId, { child, processGroupId: null, graceSec: 1 } as any);
      await spawnHook?.catch(() => undefined);
      return await Promise.race([
        done,
        new Promise((resolve) => setTimeout(
          () => resolve({ exitCode: 0, signal: null, timedOut: false, stdout: RAW_OUTPUT, stderr: RAW_OUTPUT, pid: child.pid, startedAt: new Date(0).toISOString() }),
          500,
        ).unref?.()),
      ]);
    });
    const execute = createMuseCodeExecutor({ fetchImpl: fetchImpl as any, runChildProcessImpl: processMock as any });
    const ctx = makeContext({
      signal: controller.signal,
      onSpawn: vi.fn(async () => {
        controller.abort();
        throw new Error("host onSpawn hook failed");
      }),
    });

    const result = await execute(ctx);

    expect(signals).toContain("SIGTERM");
    expect(result.errorMessage).toMatch(/cancel/i);
    expect(JSON.stringify(result)).not.toContain(ISSUE_TEXT);
    expect(JSON.stringify(result)).not.toContain(RAW_OUTPUT);
    const event = calls.find((call) => call.url.endsWith("/v1/events"))!;
    expect(JSON.parse(String(event.init.body))).toMatchObject({ result: "provider_error", quotaProvider: "meta-muse", quotaPool: "meta-muse-code" });
    expect(calls.some((call) => call.url.endsWith("/v1/reservations/reservation-1"))).toBe(true);
  });

  it("fails closed when Paperclip run scratch is not mode 0700", async () => {
    const { fetchImpl, calls } = makeFetch();
    await fs.chmod(runScratch, 0o755);
    const processMock = vi.fn();
    const execute = createMuseCodeExecutor({ fetchImpl: fetchImpl as any, runChildProcessImpl: processMock as any });

    await expect(execute(makeContext())).rejects.toThrow(/mode 0700/i);
    expect(calls).toHaveLength(0);
    expect(processMock).not.toHaveBeenCalled();
  });

  it("fails closed when the run scratch marker does not belong to this run", async () => {
    const { fetchImpl, calls } = makeFetch();
    await fs.writeFile(
      path.join(runScratch, ".paperclip-run-scratch.json"),
      JSON.stringify({ version: 1, companyId: "company-1", agentId: "other-agent", runId: "run-muse-1" }),
      { mode: 0o600 },
    );
    const processMock = vi.fn();
    const execute = createMuseCodeExecutor({ fetchImpl: fetchImpl as any, runChildProcessImpl: processMock as any });

    await expect(execute(makeContext())).rejects.toThrow(/ownership/i);
    expect(calls).toHaveLength(0);
    expect(processMock).not.toHaveBeenCalled();
  });

  it("fails closed when run scratch is inside the task repository", async () => {
    const { fetchImpl, calls } = makeFetch();
    const repositoryRoot = path.join(tempRoot, "repository");
    const repositoryWorkspace = path.join(repositoryRoot, "workspace");
    const repositoryScratch = path.join(repositoryRoot, "paperclip-run-muse-repository");
    await fs.mkdir(path.join(repositoryRoot, ".git"), { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(repositoryRoot, ".git", "HEAD"), "ref: refs/heads/main\n", { mode: 0o600 });
    await fs.mkdir(repositoryWorkspace, { recursive: true, mode: 0o700 });
    await fs.mkdir(repositoryScratch, { mode: 0o700 });
    await fs.writeFile(
      path.join(repositoryScratch, ".paperclip-run-scratch.json"),
      JSON.stringify({ version: 1, companyId: "company-1", agentId: "agent-1", runId: "run-muse-1" }),
      { mode: 0o600 },
    );
    const ctx = makeContext();
    ctx.config.cwd = repositoryWorkspace;
    ctx.context.paperclipScratch.dir = repositoryScratch;
    const processMock = vi.fn();
    const execute = createMuseCodeExecutor({ fetchImpl: fetchImpl as any, runChildProcessImpl: processMock as any });

    await expect(execute(ctx)).rejects.toThrow(/scratch|workspace/i);
    expect(calls).toHaveLength(0);
    expect(processMock).not.toHaveBeenCalled();
  });

  it("fails closed when the private scratch root is inside the task workspace", async () => {
    const { fetchImpl } = makeFetch();
    const processMock = vi.fn();
    const ctx = makeContext();
    ctx.context.paperclipScratch.dir = workspace;
    const execute = createMuseCodeExecutor({ fetchImpl: fetchImpl as any, runChildProcessImpl: processMock as any });

    await expect(execute(ctx)).rejects.toThrow(/scratch|workspace/i);
    expect(processMock).not.toHaveBeenCalled();
  });
});
