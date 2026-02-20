CREATE TABLE "user_repo_access" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" integer NOT NULL REFERENCES "users"("id"),
  "repo_id" integer NOT NULL REFERENCES "repos"("id"),
  "granted_by" integer NOT NULL REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "user_repo_access_user_id_repo_id_unique" UNIQUE("user_id", "repo_id")
);--> statement-breakpoint
CREATE INDEX "user_repo_access_user_idx" ON "user_repo_access" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_repo_access_repo_idx" ON "user_repo_access" USING btree ("repo_id");
