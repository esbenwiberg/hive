import { randomBytes } from "node:crypto";

// ── LLM Provider types ───────────────────────────────────────────────────────
// Re-exported here so domain-level code can reference ModelProvider without
// importing from the agents sub-tree.
export type {
  AnthropicProvider,
  AzureOpenAIProvider,
  AzureAnthropicProvider,
  ModelProvider,
} from "../agents/providers/types.js";

// ── Component names ──────────────────────────────────────────────────────────
// All pipeline components that can have a per-component model override.

export const ComponentNames = [
  "router",
  "gate",
  "decomposer",
  "enricher",
  "worker",
  "review-gate",
  "milestone-review",
  "producer",
  // additional internal components (used by config but not overridable via
  // componentProviders — kept here for completeness)
  "scorer",
  "refiner",
  "clarification",
  "keeper",
  "retrospective",
  "feedback-loop",
  "code-quality-analyst",
  "gate-analyst",
  "browser-validator",
  "milestone-fix",
  "architect",
] as const;

export type ComponentName = (typeof ComponentNames)[number];

// ── Per-component model config ───────────────────────────────────────────────
// Mirrors the `componentProviders.<name>` shape in autonomous.config.yaml.

export interface ComponentModelConfig {
  /** Which provider to use for this component. */
  type: "anthropic" | "azure-openai" | "azure-anthropic";
  /**
   * Model / deployment name.
   * - anthropic      → Anthropic model id, e.g. "claude-sonnet-4-6"
   * - azure-openai   → Azure deployment name or model id, e.g. "gpt-4o"
   * - azure-anthropic → model id on the Foundry deployment
   */
  model?: string;
  /** Azure AI Foundry resource endpoint (azure-openai / azure-anthropic only). */
  endpoint?: string;
  /** Deployment name inside the Foundry project (azure-openai / azure-anthropic only). */
  deploymentName?: string;
  /** API key (azure-openai / azure-anthropic).  Omit for anthropic to use env var. */
  apiKey?: string;
}

// ── SessionUser ─────────────────────────────────────────────────────────────

export interface SessionUser {
  id: number;
  entraOid: string;
  email: string;
  displayName: string;
  role: string;
}

// ── Task Status (14 states) ─────────────────────────────────────────────────

export const TaskStatus = {
  PENDING: "pending",
  QUEUED: "queued",
  ENRICHING: "enriching",
  READY: "ready",
  EXECUTING: "executing",
  REVIEWING: "reviewing",
  DONE: "done",
  MERGED: "merged",
  FAILED: "failed",
  REJECTED: "rejected",
  CANCELLED: "cancelled",
  REWORK: "rework",
  APPROVED: "approved",
  SUSPENDED: "suspended",
} as const;

export type TaskStatusValue = (typeof TaskStatus)[keyof typeof TaskStatus];

// ── Task Type ───────────────────────────────────────────────────────────────

export const TaskType = {
  BUG: "bug",
  FEATURE: "feature",
  SECURITY: "security",
  REFACTOR: "refactor",
  IMPROVEMENT: "improvement",
} as const;

export type TaskTypeValue = (typeof TaskType)[keyof typeof TaskType];

// ── Task Size ───────────────────────────────────────────────────────────────

export const TaskSize = {
  TRIVIAL: "trivial",
  SMALL: "small",
  MEDIUM: "medium",
  LARGE: "large",
} as const;

export type TaskSizeValue = (typeof TaskSize)[keyof typeof TaskSize];

// ── Workflow ────────────────────────────────────────────────────────────────

export const Workflow = {
  FLOW: "flow",
  EPIC: "epic",
} as const;

export type WorkflowValue = (typeof Workflow)[keyof typeof Workflow];

// ── Task ID generator ───────────────────────────────────────────────────────

export function generateTaskId(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const hex = randomBytes(4).toString("hex"); // 8 hex chars – avoids collisions
  return `HIVE-${y}${m}${d}-${hex}`;
}

// ── Valid value sets (for input validation) ─────────────────────────────────

const TASK_TYPE_VALUES = new Set(Object.values(TaskType));
const TASK_SIZE_VALUES = new Set(Object.values(TaskSize));

export function isValidTaskType(v: string): v is TaskTypeValue {
  return TASK_TYPE_VALUES.has(v as TaskTypeValue);
}

export function isValidTaskSize(v: string): v is TaskSizeValue {
  return TASK_SIZE_VALUES.has(v as TaskSizeValue);
}

// ── Task Visibility ──────────────────────────────────────────────────────────

export const TaskVisibility = {
  PUBLIC: "public",
  PRIVATE: "private",
} as const;

export type TaskVisibilityValue =
  (typeof TaskVisibility)[keyof typeof TaskVisibility];

const TASK_VISIBILITY_VALUES = new Set(Object.values(TaskVisibility));

export function isValidVisibility(v: string): v is TaskVisibilityValue {
  return TASK_VISIBILITY_VALUES.has(v as TaskVisibilityValue);
}

// ── Task Filters ────────────────────────────────────────────────────────────

export interface TaskFilters {
  status?: string;
  statuses?: string[];
  repoId?: number;
  createdBy?: number;
  search?: string;
  visibility?: string;
}

// ── Execution Types ────────────────────────────────────────────────────────

export interface WorktreeInfo {
  path: string;
  branch: string;
  repoFullName: string;
  provider: string;
  createdAt: Date;
  /** SHA of the commit the feature branch was created from (used for diffing). */
  baseSha: string;
  /** True when createWorktree checked out an existing remote branch instead of creating a new one. */
  recovered?: boolean;
}

export interface ReviewFinding {
  severity: "critical" | "major" | "minor" | "info";
  file: string;
  line?: number;
  message: string;
  category: string;
}

export interface SecurityFinding {
  severity: "critical" | "high" | "medium" | "low";
  type: string;
  description: string;
  file?: string;
  /** True for architectural/design-level observations that should not block rework cycles. */
  advisory?: boolean;
}

export interface VerificationResult {
  testsRun: boolean;
  testsPassed: boolean;
  lintClean: boolean;
  buildSucceeded: boolean;
  notes: string[];
}

export interface ReviewGateResult {
  verdict: "pass" | "rework" | "fail";
  findings: ReviewFinding[];
  securityFindings: SecurityFinding[];
  verification: VerificationResult;
  costUsd: number;
  /** Files actually changed in the worktree (relative paths from git diff). */
  changedFiles?: string[];
}

export interface GitCredentials {
  provider: string;
  token: string;
  username?: string;
}

export interface WorkerResult {
  success: boolean;
  prUrl?: string;
  previewUrl?: string;
  branch?: string;
  reviewResult?: ReviewGateResult;
  error?: string;
}

export type PreviewStatus = "starting" | "running" | "failed" | "stopped";

export interface MilestoneSpec {
  title: string;
  body: string;
  index: number;
  total: number;
}
