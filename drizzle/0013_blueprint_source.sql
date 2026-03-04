ALTER TABLE "tasks" ADD COLUMN "blueprint_source" text NOT NULL DEFAULT 'architect';
ALTER TABLE "tasks" ADD COLUMN "user_blueprint_markdown" text;
