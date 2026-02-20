ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "skip_preview" boolean DEFAULT false NOT NULL;
