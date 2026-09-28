CREATE TABLE "token_quota_monitor_state" (
	"issue_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"routing_fingerprint" text,
	"baseline_at" timestamp with time zone,
	"notified_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "issues" ADD COLUMN "monitor_external_ref" text;--> statement-breakpoint
ALTER TABLE "token_quota_monitor_state" ADD CONSTRAINT "token_quota_monitor_state_issue_id_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_quota_monitor_state" ADD CONSTRAINT "token_quota_monitor_state_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;