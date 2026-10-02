/**
 * Terminal heartbeat-run statuses (extracted JES-338/JES-351).
 *
 * Leaf module on purpose: the set is needed by the checkout-lock sweeper,
 * which is wired into server startup (`server/src/index.ts`). Importing it
 * from `./issues.js` drags the whole issues/documents import closure into
 * startup, which breaks suites that mock `@paperclipai/db` without table
 * exports (e.g. `server-startup-feedback-export.test.ts`). `issues.ts`
 * re-exports this name, so existing importers are unaffected.
 */
export const TERMINAL_HEARTBEAT_RUN_STATUSES = new Set([
  "succeeded",
  "interrupted",
  "failed",
  "cancelled",
  "timed_out",
]);
