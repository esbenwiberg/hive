CREATE TABLE "active_agents" (
	"task_id" text PRIMARY KEY NOT NULL,
	"agent" text NOT NULL,
	"model" text NOT NULL,
	"phase" text,
	"started_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "code_reviews" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"verdict" text NOT NULL,
	"rework_cycle" integer DEFAULT 0,
	"findings" jsonb,
	"security_findings" jsonb,
	"verification" jsonb,
	"cost_usd" numeric(10, 4),
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "costs" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"user_id" integer NOT NULL,
	"agent" text NOT NULL,
	"model" text NOT NULL,
	"repo" text,
	"cost_usd" numeric(10, 4) NOT NULL,
	"turns" integer,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "enrichment_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"enricher" text NOT NULL,
	"status" text NOT NULL,
	"result" jsonb,
	"cost_usd" numeric(10, 4),
	"duration_ms" integer,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "gate_decisions" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"verdict" text NOT NULL,
	"source" text NOT NULL,
	"decided_by" integer,
	"reasoning" text,
	"task_context" jsonb,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "global_config" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "learning_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"learning_id" integer NOT NULL,
	"event_type" text NOT NULL,
	"task_id" text,
	"evidence" text,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "learnings" (
	"id" serial PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"category" text NOT NULL,
	"content" text NOT NULL,
	"confidence" numeric(3, 2) DEFAULT '0.50',
	"reinforcements" integer DEFAULT 0,
	"contradictions" integer DEFAULT 0,
	"source_task_ids" text[],
	"tags" text[],
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	"last_used_at" timestamp with time zone,
	"superseded_by" integer
);
--> statement-breakpoint
CREATE TABLE "preview_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"source" text NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "producer_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"producer" text NOT NULL,
	"repo" text,
	"tasks_created" integer DEFAULT 0,
	"duplicates_skipped" integer DEFAULT 0,
	"errors" jsonb DEFAULT '[]'::jsonb,
	"cost_usd" numeric(10, 4),
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "repos" (
	"id" serial PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"full_name" text NOT NULL,
	"default_branch" text DEFAULT 'main',
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "repos_provider_full_name_unique" UNIQUE("provider","full_name")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"sid" text PRIMARY KEY NOT NULL,
	"sess" jsonb NOT NULL,
	"expire" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"created_by" integer NOT NULL,
	"approved_by" integer,
	"repo_id" integer NOT NULL,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"type" text,
	"severity" text,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"size" text,
	"workflow" text,
	"model" text,
	"max_turns" integer,
	"max_budget_usd" numeric(10, 2),
	"enrichment" jsonb,
	"gate_verdict" text,
	"gate_reasoning" text,
	"execution_attempts" integer DEFAULT 0,
	"pr_url" text,
	"failure_reason" text,
	"rework_count" integer DEFAULT 0,
	"rework_history" jsonb DEFAULT '[]'::jsonb,
	"retry_instructions" text,
	"epic_id" text,
	"milestone_index" integer,
	"milestone_total" integer,
	"blueprint" text,
	"preview_port" integer,
	"preview_status" text,
	"preview_started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "user_credentials" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"provider" text NOT NULL,
	"vault_secret_id" text NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "user_credentials_user_id_provider_label_unique" UNIQUE("user_id","provider","label")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"entra_oid" text NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"daily_budget" numeric(10, 2) DEFAULT '100.00',
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "users_entra_oid_unique" UNIQUE("entra_oid"),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "active_agents" ADD CONSTRAINT "active_agents_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "code_reviews" ADD CONSTRAINT "code_reviews_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "costs" ADD CONSTRAINT "costs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "costs" ADD CONSTRAINT "costs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrichment_runs" ADD CONSTRAINT "enrichment_runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_decisions" ADD CONSTRAINT "gate_decisions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gate_decisions" ADD CONSTRAINT "gate_decisions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_events" ADD CONSTRAINT "learning_events_learning_id_learnings_id_fk" FOREIGN KEY ("learning_id") REFERENCES "public"."learnings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_events" ADD CONSTRAINT "learning_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "preview_logs" ADD CONSTRAINT "preview_logs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_credentials" ADD CONSTRAINT "user_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "costs_user_created_idx" ON "costs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "costs_task_idx" ON "costs" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "costs_created_idx" ON "costs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "enrichment_runs_task_idx" ON "enrichment_runs" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "learnings_scope_idx" ON "learnings" USING btree ("scope");--> statement-breakpoint
CREATE INDEX "learnings_tags_idx" ON "learnings" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "learnings_confidence_idx" ON "learnings" USING btree ("confidence");--> statement-breakpoint
CREATE INDEX "preview_logs_task_created_idx" ON "preview_logs" USING btree ("task_id","created_at");