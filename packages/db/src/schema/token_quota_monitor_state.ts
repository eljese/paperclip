import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

/**
 * Durable per-issue state for the server-owned token-quota cheap poll.
 *
 * One row per monitored issue. The routing fingerprint baseline plus the set
 * of already-notified threshold identities let the poller wake the assignee
 * exactly once per condition while healthy polls stay silent (zero Pi runs).
 */
export const tokenQuotaMonitorState = pgTable("token_quota_monitor_state", {
  issueId: uuid("issue_id")
    .primaryKey()
    .references(() => issues.id, { onDelete: "cascade" }),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id),
  routingFingerprint: text("routing_fingerprint"),
  baselineAt: timestamp("baseline_at", { withTimezone: true }),
  notifiedKeys: jsonb("notified_keys").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
