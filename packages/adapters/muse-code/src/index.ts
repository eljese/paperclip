import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterConfigSchema,
  ServerAdapterModule,
} from "@paperclipai/adapter-utils";
import { ensureCommandResolvable } from "@paperclipai/adapter-utils/server-utils";
import { execute } from "./server/execute.js";

export const type = "muse_code";
export const label = "Muse Code";
export const agentConfigurationDoc = `# Muse Code

Use this adapter for local implementation work executed by the Muse Code CLI.
Paperclip continues to own task state, budgets, delegation, and progress. The
plan-quota-dash service selects and reserves the configured Muse Code subscription
model. Muse Code does not select a fallback model.

The supported plan-quota-dash routes are \`muse-code-wonder-1.0\` →
\`muse-wonder-1.0\` and \`muse-code-spark-1.3\` → \`muse-spark-1.3\`. Both use the
\`muse-code\` executor, \`meta-muse\` quota provider, \`meta-muse-code\` subscription
pool, and subscription cost type. Manual-only selection remains disabled. The
adapter fails closed if the selection differs.

Install Muse Code 1.4.7 or a compatible release on the Paperclip host. Set the
agent working directory to its Paperclip execution workspace. Keep the quota
service on loopback when possible. If it requires a token, set
\`QUOTA_CONTROL_TOKEN\` or \`DASHBOARD_TOKEN\` in the Paperclip server environment.
Do not set \`META_API_KEY\`; that environment variable overrides the saved Meta
account login and can route execution to PAYG. Use the saved Muse Code Meta
account login for subscription execution.

Task context is written to a private mode-0600 file beneath Paperclip's run-owned
mode-0700 scratch directory. The CLI receives only the file path, never prompt
text in argv or environment. Muse Code session logging is disabled, and its
process-lifetime temporary output root is directed to that private directory.
Raw stdout and stderr are withheld from Paperclip logs and persisted run results.
The CLI keeps its sandbox enabled, uses proxy-only network access, and asks for
tool approval on request. Contributor mode is not overridden.

This adapter currently supports local Paperclip execution targets only. It does
not provide planning, review, quota routing, or an independent task orchestrator.
`;

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "cwd",
        label: "Working directory",
        type: "text",
        required: true,
        hint: "Use the Paperclip execution workspace path.",
      },
      {
        key: "controlPlaneUrl",
        label: "Plan quota control URL",
        type: "text",
        default: "http://127.0.0.1:8787",
        required: true,
      },
      {
        key: "promptTemplate",
        label: "Agent instructions",
        type: "textarea",
        default: "",
        hint: "Optional instructions. Paperclip task and wake context is added separately.",
      },
      {
        key: "timeoutSec",
        label: "Execution timeout (seconds)",
        type: "number",
        default: 900,
      },
      {
        key: "graceSec",
        label: "Cancellation grace (seconds)",
        type: "number",
        default: 15,
      },
    ],
  };
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const cwd = typeof ctx.config.cwd === "string" ? ctx.config.cwd.trim() : "";
  const target = ctx.executionTarget;
  if (target?.kind === "remote") {
    checks.push({
      code: "local_execution_required",
      level: "error",
      message: "Muse Code adapter supports local execution targets only.",
    });
  }
  if (!cwd || !cwd.startsWith("/")) {
    checks.push({
      code: "invalid_cwd",
      level: "error",
      message: "Working directory must be an absolute path.",
    });
  } else {
    try {
      await ensureCommandResolvable("muse", cwd, process.env);
      checks.push({
        code: "muse_cli_available",
        level: "info",
        message: "Muse Code CLI is available.",
      });
    } catch {
      checks.push({
        code: "muse_cli_missing",
        level: "error",
        message: "Muse Code CLI is not available on the Paperclip host PATH.",
        hint: "Install Muse Code on the Paperclip host and retry.",
      });
    }
  }
  const status = checks.some((check) => check.level === "error") ? "fail" : "pass";
  return {
    adapterType: ctx.adapterType,
    status,
    checks,
    testedAt: new Date().toISOString(),
  };
}

export { execute };

export function createServerAdapter(): ServerAdapterModule {
  return {
    type,
    execute,
    testEnvironment,
    getConfigSchema,
    agentConfigurationDoc,
    supportsLocalAgentJwt: true,
    runtimeToolDelivery: "environment",
  };
}
