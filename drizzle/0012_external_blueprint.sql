-- Add blueprint_source and external_blueprint columns to tasks table
ALTER TABLE "tasks" ADD COLUMN "blueprint_source" text NOT NULL DEFAULT 'architect';
ALTER TABLE "tasks" ADD COLUMN "external_blueprint" jsonb;
