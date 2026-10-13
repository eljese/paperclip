# Paperclip Muse Code adapter

This package is an external Paperclip adapter. It keeps execution outside the
Paperclip server while using Paperclip's adapter plugin contract.

## Scope

- Paperclip owns task lifecycle, budgets, delegation, and progress.
- `plan-quota-dash` selects and reserves one allowed Muse Code subscription route.
- Muse Code CLI executes the task in the Paperclip workspace.
- This adapter does not route planning or review work.

The adapter supports two exact routes: candidate `muse-code-wonder-1.0` maps to
model `muse-wonder-1.0`, and candidate `muse-code-spark-1.3` maps to model
`muse-spark-1.3`. Both require executor provider `muse-code`, quota provider
`meta-muse`, quota pool `meta-muse-code`, and subscription billing. The adapter
rejects any selection that differs. It sends `allowManual: false` and does not
override a manual-only setting.

## Install as an external adapter

Build the package, then install its absolute directory path through Paperclip's
adapter plugin route or the **Settings → Adapters** page:

```sh
pnpm --filter @paperclipai/adapter-muse-code build
```

```json
{
  "packageName": "/absolute/path/to/paperclip/packages/adapters/muse-code",
  "isLocalPath": true
}
```

The plugin loader reads the built `dist/index.js` entry point. Do not install or
restart a production Paperclip service as part of development verification.

## Agent configuration

Set the agent's working directory to its Paperclip execution workspace. Use the
plan-quota-dash URL `http://127.0.0.1:8787` unless the control plane is exposed
through HTTPS. HTTP is accepted only for loopback. If the service requires a
token, set `QUOTA_CONTROL_TOKEN` or `DASHBOARD_TOKEN` in the Paperclip server
environment; the token is used only for adapter API calls and is blanked in the
Muse Code child environment.

Use a saved Muse Code Meta account login for the subscription. Do not configure
`META_API_KEY`; Muse Code documents that this environment key overrides its
saved account login and can use the Model API instead. The adapter explicitly
clears that environment key for the child. It does not call Meta's Model API or
add a pay-as-you-go fallback.

Optional adapter settings are an instruction template, an execution timeout
(default 900 seconds), and a cancellation grace period (default 15 seconds).

## Context, logging, and safety

The adapter renders Paperclip's shared task/wake context helpers. It writes the
result to a regular prompt file in a mode-0700 subdirectory of Paperclip's
run-owned scratch root, with file mode 0600. It passes only the file path to
`muse exec --prompt-file`; task text is not placed in argv or environment.

The child receives a private `TMPDIR`, `TEMP`, and `TMP` under that same
run-owned scratch directory. `--no-session-log` is used so session event logs are
not retained. The Muse Code runtime also checks that its process-lifetime
tool-output root is outside the configured workspace/repository. If Paperclip
cannot prove its scratch root is outside the task workspace, the adapter fails
before selecting a model. It removes the prompt directory after process exit,
timeout, cancellation, or failure.

The adapter suppresses raw Muse Code stdout/stderr. Paperclip run logs and result
JSON contain only status, exit code, signal, duration, and the selected model.
Cleanup failures produce a generic, content-free log line. The plan-control API
receives only candidate IDs and normalized result events, never task context or
model output.

The CLI runs with its sandbox enabled in the Paperclip execution workspace,
explicit `on-request` tool approval, and `proxy-only` network access. It does not
pass `--yolo`, `--disable-sandbox`, `--disable-approval`, `--contributor-mode`, or an
alternative model. Remote Paperclip execution targets are rejected.

## Tests

Tests use fake HTTP responses and fake child processes. They do not call a model
or mutate the plan-quota-dash service.

```sh
pnpm exec vitest run packages/adapters/muse-code/src/server/execute.test.ts
pnpm --filter @paperclipai/adapter-muse-code typecheck
```
