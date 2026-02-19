CREATE TABLE "task_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"event" text NOT NULL,
	"agent" text NOT NULL,
	"message" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "user_credentials" ALTER COLUMN "label" SET DEFAULT 'default';--> statement-breakpoint
ALTER TABLE "active_agents" ADD COLUMN "last_heartbeat_at" timestamp with time zone DEFAULT now();--> statement-breakpoint
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_events_task_created_idx" ON "task_events" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "tasks_status_idx" ON "tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tasks_repo_id_idx" ON "tasks" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "tasks_created_by_idx" ON "tasks" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "tasks_created_at_idx" ON "tasks" USING btree ("created_at");