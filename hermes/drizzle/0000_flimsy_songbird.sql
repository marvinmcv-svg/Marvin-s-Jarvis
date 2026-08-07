CREATE TABLE "agent_memory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"scope" text DEFAULT 'global' NOT NULL,
	"scope_key" text,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"confidence" real DEFAULT 0.5 NOT NULL,
	"evidence_count" integer DEFAULT 1 NOT NULL,
	"tags" jsonb,
	"evidence" jsonb,
	"source_run_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"superseded_by" uuid,
	"last_used_at" timestamp with time zone,
	"use_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job" text NOT NULL,
	"city" text,
	"niche" text,
	"batch_id" uuid,
	"status" text DEFAULT 'running' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"metrics" jsonb,
	"phase_log" jsonb,
	"error" text,
	"reflection" text
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"place_id" text,
	"dedup_hash" text NOT NULL,
	"name" text NOT NULL,
	"city" text NOT NULL,
	"niche" text NOT NULL,
	"address" text,
	"phone" text,
	"whatsapp" text,
	"email" text,
	"website" text,
	"linkedin" text,
	"instagram" text,
	"facebook" text,
	"other_socials" jsonb,
	"rating" numeric,
	"reviews_count" integer,
	"raw" jsonb,
	"quality_score" integer,
	"score_weights_version" integer,
	"score_breakdown" jsonb,
	"audit" jsonb,
	"status" text DEFAULT 'new' NOT NULL,
	"batch_id" uuid,
	"sent_at" timestamp with time zone,
	"preview_pending" boolean DEFAULT false NOT NULL,
	"preview_payload" jsonb,
	"preview_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "niche_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"city" text NOT NULL,
	"niche" text NOT NULL,
	"sent_count" integer DEFAULT 0 NOT NULL,
	"week_cap" integer DEFAULT 250 NOT NULL,
	"daily_target" integer DEFAULT 50 NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"exhausted" boolean DEFAULT false NOT NULL,
	"short_days" integer DEFAULT 0 NOT NULL,
	"queue_index" integer,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "outreach" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"variant" text NOT NULL,
	"angle" text,
	"channel" text DEFAULT 'email' NOT NULL,
	"subject" text,
	"body" text NOT NULL,
	"personalization_hook" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"batch_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pitch_performance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"angle" text NOT NULL,
	"variant" text,
	"niche" text,
	"city" text,
	"sent_count" integer DEFAULT 0 NOT NULL,
	"reply_count" integer DEFAULT 0 NOT NULL,
	"positive_count" integer DEFAULT 0 NOT NULL,
	"negative_count" integer DEFAULT 0 NOT NULL,
	"reply_rate" real DEFAULT 0 NOT NULL,
	"last_sent_at" timestamp with time zone,
	"last_reply_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "replies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lead_id" uuid NOT NULL,
	"outreach_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"from_email" text,
	"subject" text,
	"snippet" text,
	"sentiment" text,
	"message_id" text,
	"handled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "score_weights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" integer NOT NULL,
	"weights" jsonb NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"leads_scored" integer DEFAULT 0 NOT NULL,
	"leads_sent" integer DEFAULT 0 NOT NULL,
	"replies_seen" integer DEFAULT 0 NOT NULL,
	"calibration" real,
	"rationale" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scraper_health" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_date" date NOT NULL,
	"source" text NOT NULL,
	"ok" boolean NOT NULL,
	"found" integer,
	"expected" integer,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "selector_memory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"field" text NOT NULL,
	"selector" text NOT NULL,
	"success_count" integer DEFAULT 0 NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_ok_at" timestamp with time zone,
	"last_fail_at" timestamp with time zone,
	"learned" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_memory" ADD CONSTRAINT "agent_memory_source_run_id_agent_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."agent_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outreach" ADD CONSTRAINT "outreach_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replies" ADD CONSTRAINT "replies_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replies" ADD CONSTRAINT "replies_outreach_id_outreach_id_fk" FOREIGN KEY ("outreach_id") REFERENCES "public"."outreach"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_memory_hash_uniq" ON "agent_memory" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "agent_memory_scope_idx" ON "agent_memory" USING btree ("scope","scope_key","active");--> statement-breakpoint
CREATE INDEX "agent_memory_kind_idx" ON "agent_memory" USING btree ("kind","active");--> statement-breakpoint
CREATE INDEX "agent_runs_job_idx" ON "agent_runs" USING btree ("job","started_at");--> statement-breakpoint
CREATE INDEX "agent_runs_batch_idx" ON "agent_runs" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_place_id_uniq" ON "leads" USING btree ("place_id");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_dedup_hash_uniq" ON "leads" USING btree ("dedup_hash");--> statement-breakpoint
CREATE INDEX "leads_city_niche_idx" ON "leads" USING btree ("city","niche");--> statement-breakpoint
CREATE INDEX "leads_status_idx" ON "leads" USING btree ("status");--> statement-breakpoint
CREATE INDEX "leads_batch_idx" ON "leads" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "niche_runs_city_niche_uniq" ON "niche_runs" USING btree ("city","niche");--> statement-breakpoint
CREATE INDEX "niche_runs_active_idx" ON "niche_runs" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "outreach_lead_idx" ON "outreach" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "outreach_angle_idx" ON "outreach" USING btree ("angle");--> statement-breakpoint
CREATE INDEX "outreach_batch_idx" ON "outreach" USING btree ("batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pitch_perf_bucket_uniq" ON "pitch_performance" USING btree ("angle","niche","city");--> statement-breakpoint
CREATE INDEX "pitch_perf_rate_idx" ON "pitch_performance" USING btree ("reply_rate");--> statement-breakpoint
CREATE UNIQUE INDEX "replies_message_id_uniq" ON "replies" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "replies_lead_idx" ON "replies" USING btree ("lead_id");--> statement-breakpoint
CREATE UNIQUE INDEX "score_weights_version_uniq" ON "score_weights" USING btree ("version");--> statement-breakpoint
CREATE INDEX "score_weights_active_idx" ON "score_weights" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "scraper_health_date_idx" ON "scraper_health" USING btree ("run_date","source");--> statement-breakpoint
CREATE UNIQUE INDEX "selector_memory_uniq" ON "selector_memory" USING btree ("source","field","selector");--> statement-breakpoint
CREATE INDEX "selector_memory_lookup_idx" ON "selector_memory" USING btree ("source","field","active");