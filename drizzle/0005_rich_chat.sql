ALTER TABLE "learnings" ADD COLUMN IF NOT EXISTS "dismissed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "learnings" ADD COLUMN IF NOT EXISTS "dismissed_by" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "visibility" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_repo_access" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"repo_id" integer NOT NULL,
	"granted_by" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "user_repo_access_user_id_repo_id_unique" UNIQUE("user_id","repo_id")
);--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "user_repo_access" ADD CONSTRAINT "user_repo_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "user_repo_access" ADD CONSTRAINT "user_repo_access_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "user_repo_access" ADD CONSTRAINT "user_repo_access_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_repo_access_user_idx" ON "user_repo_access" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_repo_access_repo_idx" ON "user_repo_access" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_visibility_idx" ON "tasks" USING btree ("visibility");
