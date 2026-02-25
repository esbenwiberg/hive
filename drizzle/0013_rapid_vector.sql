ALTER TABLE "tasks" ADD COLUMN "blueprint_source" text DEFAULT 'architect' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "user_blueprint_markdown" text;
