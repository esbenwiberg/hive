import type { InferSelectModel } from "drizzle-orm";
import {
  pgTable,
  serial,
  text,
  integer,
  numeric,
  boolean,
  jsonb,
  timestamp,
  unique,
  index,
} from "drizzle-orm/pg-core";

const tz = { withTimezone: true } as const;

// ── users ──────────────────────────────────────────────────────────────────

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  entraOid: text("entra_oid").unique().notNull(),
  email: text("email").unique().notNull(),
  displayName: text("display_name").notNull(),
  role: text("role").notNull().default("user"),
  dailyBudget: numeric("daily_budget", { precision: 10, scale: 2 }).default(
    "100.00",
  ),
  maxConcurrent: integer("max_concurrent"),
  createdAt: timestamp("created_at", tz).defaultNow(),
  updatedAt: timestamp("updated_at", tz).defaultNow(),
});

// ── user_credentials ───────────────────────────────────────────────────────

export const userCredentials = pgTable(
  "user_credentials",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    provider: text("provider").notNull(),
    vaultSecretId: text("vault_secret_id").notNull(),
    label: text("label").default("default"),
    createdAt: timestamp("created_at", tz).defaultNow(),
  },
  (t) => [unique().on(t.userId, t.provider, t.label)],
);

// ── repos ──────────────────────────────────────────────────────────────────

export const repos = pgTable(
  "repos",
  {
    id: serial("id").primaryKey(),
    provider: text("provider").notNull(),
    fullName: text("full_name").notNull(),
    defaultBranch: text("default_branch").default("main"),
    settings: jsonb("settings").notNull().default({}),
    createdAt: timestamp("created_at", tz).defaultNow(),
    updatedAt: timestamp("updated_at", tz).defaultNow(),
  },
  (t) => [unique().on(t.provider, t.fullName)],
);

// ── tasks ──────────────────────────────────────────────────────────────────

export const tasks = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    createdBy: integer("created_by")
      .notNull()
      .references(() => users.id),
    approvedBy: integer("approved_by").references(() => users.id),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repos.id),
    source: text("source").notNull(),
    status: text("status").notNull(),
    type: text("type"),
    severity: text("severity"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    size: text("size"),
    workflow: text("workflow"),
    model: text("model"),
    maxTurns: integer("max_turns"),
    maxBudgetUsd: numeric("max_budget_usd", { precision: 10, scale: 2 }),
    enrichment: jsonb("enrichment"),
    gateVerdict: text("gate_verdict"),
    gateReasoning: text("gate_reasoning"),
    executionAttempts: integer("execution_attempts").default(0),
    prUrl: text("pr_url"),
    failureReason: text("failure_reason"),
    reworkCount: integer("rework_count").default(0),
    maxReworkCycles: integer("max_rework_cycles").default(2),
    reworkHistory: jsonb("rework_history").default([]),
    retryInstructions: text("retry_instructions"),
    epicId: text("epic_id"),
    milestoneIndex: integer("milestone_index"),
    milestoneTotal: integer("milestone_total"),
    blueprint: text("blueprint"),
    previewPort: integer("preview_port"),
    previewStatus: text("preview_status"),
    previewUrl: text("preview_url"),
    suspendedFrom: text("suspended_from"),
    previewStartedAt: timestamp("preview_started_at", tz),
    skipPreview: boolean("skip_preview").notNull().default(false),
    worktreePath: text("worktree_path"),
    worktreeBaseSha: text("worktree_base_sha"),
    completedMilestones: integer("completed_milestones").default(0),
    visibility: text("visibility").notNull().default("public"),
    blueprintSource: text("blueprint_source").notNull().default("architect"),
    userBlueprintMarkdown: text("user_blueprint_markdown"),
    createdAt: timestamp("created_at", tz).defaultNow(),
    updatedAt: timestamp("updated_at", tz).defaultNow(),
  },
  (t) => [
    index("tasks_status_idx").on(t.status),
    index("tasks_repo_id_idx").on(t.repoId),
    index("tasks_created_by_idx").on(t.createdBy),
    index("tasks_created_at_idx").on(t.createdAt),
    index("tasks_visibility_idx").on(t.visibility),
  ],
);

// ── costs ──────────────────────────────────────────────────────────────────

export const costs = pgTable(
  "costs",
  {
    id: serial("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    agent: text("agent").notNull(),
    model: text("model").notNull(),
    repo: text("repo"),
    costUsd: numeric("cost_usd", { precision: 10, scale: 4 }).notNull(),
    turns: integer("turns"),
    durationMs: integer("duration_ms"),
    createdAt: timestamp("created_at", tz).defaultNow(),
  },
  (t) => [
    index("costs_user_created_idx").on(t.userId, t.createdAt),
    index("costs_task_idx").on(t.taskId),
    index("costs_created_idx").on(t.createdAt),
  ],
);

// ── gate_decisions ─────────────────────────────────────────────────────────

export const gateDecisions = pgTable("gate_decisions", {
  id: serial("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id),
  verdict: text("verdict").notNull(),
  source: text("source").notNull(),
  decidedBy: integer("decided_by").references(() => users.id),
  reasoning: text("reasoning"),
  taskContext: jsonb("task_context"),
  createdAt: timestamp("created_at", tz).defaultNow(),
});

// ── code_reviews ───────────────────────────────────────────────────────────

export const codeReviews = pgTable("code_reviews", {
  id: serial("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id),
  verdict: text("verdict").notNull(),
  reworkCycle: integer("rework_cycle").default(0),
  findings: jsonb("findings"),
  securityFindings: jsonb("security_findings"),
  verification: jsonb("verification"),
  changedFiles: jsonb("changed_files"),
  costUsd: numeric("cost_usd", { precision: 10, scale: 4 }),
  createdAt: timestamp("created_at", tz).defaultNow(),
});

// ── active_agents ──────────────────────────────────────────────────────────

export const activeAgents = pgTable("active_agents", {
  taskId: text("task_id")
    .primaryKey()
    .references(() => tasks.id),
  agent: text("agent").notNull(),
  model: text("model").notNull(),
  phase: text("phase"),
  startedAt: timestamp("started_at", tz).defaultNow(),
  lastHeartbeatAt: timestamp("last_heartbeat_at", tz).defaultNow(),
});

// ── task_events ───────────────────────────────────────────────────────────

export const taskEvents = pgTable(
  "task_events",
  {
    id: serial("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    event: text("event").notNull(),
    agent: text("agent").notNull(),
    message: text("message").notNull(),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", tz).defaultNow(),
  },
  (t) => [index("task_events_task_created_idx").on(t.taskId, t.createdAt)],
);

// ── enrichment_runs ────────────────────────────────────────────────────────

export const enrichmentRuns = pgTable(
  "enrichment_runs",
  {
    id: serial("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    enricher: text("enricher").notNull(),
    status: text("status").notNull(),
    result: jsonb("result"),
    costUsd: numeric("cost_usd", { precision: 10, scale: 4 }),
    durationMs: integer("duration_ms"),
    error: text("error"),
    createdAt: timestamp("created_at", tz).defaultNow(),
  },
  (t) => [index("enrichment_runs_task_idx").on(t.taskId)],
);

// ── producer_runs ──────────────────────────────────────────────────────────

export const producerRuns = pgTable("producer_runs", {
  id: serial("id").primaryKey(),
  producer: text("producer").notNull(),
  repo: text("repo"),
  tasksCreated: integer("tasks_created").default(0),
  duplicatesSkipped: integer("duplicates_skipped").default(0),
  errors: jsonb("errors").default([]),
  costUsd: numeric("cost_usd", { precision: 10, scale: 4 }),
  durationMs: integer("duration_ms"),
  createdAt: timestamp("created_at", tz).defaultNow(),
});

// ── preview_logs ───────────────────────────────────────────────────────────

export const previewLogs = pgTable(
  "preview_logs",
  {
    id: serial("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    source: text("source").notNull(),
    message: text("message").notNull(),
    createdAt: timestamp("created_at", tz).defaultNow(),
  },
  (t) => [index("preview_logs_task_created_idx").on(t.taskId, t.createdAt)],
);

// ── learnings ──────────────────────────────────────────────────────────────

export const learnings = pgTable(
  "learnings",
  {
    id: serial("id").primaryKey(),
    scope: text("scope").notNull(),
    category: text("category").notNull(),
    content: text("content").notNull(),
    confidence: numeric("confidence", { precision: 3, scale: 2 }).default(
      "0.50",
    ),
    reinforcements: integer("reinforcements").default(0),
    contradictions: integer("contradictions").default(0),
    sourceTaskIds: text("source_task_ids").array(),
    tags: text("tags").array(),
    createdAt: timestamp("created_at", tz).defaultNow(),
    updatedAt: timestamp("updated_at", tz).defaultNow(),
    lastUsedAt: timestamp("last_used_at", tz),
    supersededBy: integer("superseded_by"),
    dismissedAt: timestamp("dismissed_at", tz),
    dismissedBy: text("dismissed_by"),
  },
  (t) => [
    index("learnings_scope_idx").on(t.scope),
    index("learnings_tags_idx").using("gin", t.tags),
    index("learnings_confidence_idx").on(t.confidence),
  ],
);

// ── learning_events ────────────────────────────────────────────────────────

export const learningEvents = pgTable("learning_events", {
  id: serial("id").primaryKey(),
  learningId: integer("learning_id")
    .notNull()
    .references(() => learnings.id),
  eventType: text("event_type").notNull(),
  taskId: text("task_id").references(() => tasks.id),
  evidence: text("evidence"),
  createdAt: timestamp("created_at", tz).defaultNow(),
});

// ── user_repo_access ──────────────────────────────────────────────────────

export const userRepoAccess = pgTable(
  "user_repo_access",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repos.id),
    grantedBy: integer("granted_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", tz).defaultNow(),
  },
  (t) => [
    unique().on(t.userId, t.repoId),
    index("user_repo_access_user_idx").on(t.userId),
    index("user_repo_access_repo_idx").on(t.repoId),
  ],
);

// ── sessions ───────────────────────────────────────────────────────────────

export const sessions = pgTable("sessions", {
  sid: text("sid").primaryKey(),
  sess: jsonb("sess").notNull(),
  expire: timestamp("expire", tz).notNull(),
});

// ── global_config ──────────────────────────────────────────────────────────

export const globalConfig = pgTable("global_config", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", tz).defaultNow(),
});

// ── Inferred row types ──────────────────────────────────────────────────────

export type TaskRow = InferSelectModel<typeof tasks>;
export type RepoRow = InferSelectModel<typeof repos>;
export type CodeReviewRow = InferSelectModel<typeof codeReviews>;
export type ActiveAgentRow = InferSelectModel<typeof activeAgents>;
export type TaskEventRow = InferSelectModel<typeof taskEvents>;
export type UserCredentialRow = InferSelectModel<typeof userCredentials>;
export type LearningRow = InferSelectModel<typeof learnings>;
export type LearningEventRow = InferSelectModel<typeof learningEvents>;
export type UserRepoAccessRow = InferSelectModel<typeof userRepoAccess>;
export type EnrichmentRunRow = InferSelectModel<typeof enrichmentRuns>;
