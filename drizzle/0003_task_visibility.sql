ALTER TABLE "tasks" ADD COLUMN "visibility" text NOT NULL DEFAULT 'public';--> statement-breakpoint
CREATE INDEX "tasks_visibility_idx" ON "tasks" USING btree ("visibility");
