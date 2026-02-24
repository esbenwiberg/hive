-- Migration 0012: Add llm_usage table for fine-grained per-call token tracking
-- with Azure AI Foundry provider metadata support.
--
-- provider_type: 'anthropic' | 'azure-openai' | 'azure-anthropic'
-- endpoint:       Azure AI Foundry endpoint URL (NULL for direct Anthropic)
-- deployment_name: Azure deployment name (NULL for direct Anthropic)
--
-- Token counts are normalised: Anthropic (input_tokens/output_tokens) and
-- OpenAI-compatible (prompt_tokens/completion_tokens) both map to
-- input_tokens/output_tokens in this table.

CREATE TABLE IF NOT EXISTS "llm_usage" (
  "id"                          serial PRIMARY KEY,
  "task_id"                     text REFERENCES "tasks"("id"),
  "agent"                       text NOT NULL,
  "model"                       text NOT NULL,
  "provider_type"               text NOT NULL,
  "endpoint"                    text,
  "deployment_name"             text,
  "input_tokens"                integer NOT NULL,
  "output_tokens"               integer NOT NULL,
  "cache_creation_input_tokens" integer,
  "cache_read_input_tokens"     integer,
  "cost_usd"                    numeric(10, 6) NOT NULL DEFAULT 0,
  "created_at"                  timestamp with time zone DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "llm_usage_task_idx"     ON "llm_usage" ("task_id");
CREATE INDEX IF NOT EXISTS "llm_usage_provider_idx" ON "llm_usage" ("provider_type");
CREATE INDEX IF NOT EXISTS "llm_usage_created_idx"  ON "llm_usage" ("created_at");
