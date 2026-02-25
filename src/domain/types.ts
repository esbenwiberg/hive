import { randomBytes } from "node:crypto";

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

// ── Blueprint Source ─────────────────────────────────────────────────────────

export const BlueprintSource = {
  ARCHITECT: "architect",
  USER: "user",
} as const;

export type BlueprintSourceValue =
  (typeof BlueprintSource)[keyof typeof BlueprintSource];

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

// ── Blueprint (user-supplied) ───────────────────────────────────────────────
//
// These mirror the types in src/blueprints/schema.ts but are re-exported from
// the central domain types module so the rest of the codebase can import them
// from a single location.

export interface BlueprintMilestone {
  /** Short, imperative title for this milestone. */
  title: string;
  /** One or more sentences describing what this milestone achieves. */
  description: string;
  /** Relative file paths that this milestone is expected to touch. */
  filesToModify: string[];
  /** Observable, testable criteria that confirm this milestone is complete. */
  acceptanceCriteria: string[];
}

export interface Blueprint {
  /** High-level implementation strategy shared across all milestones. */
  approach: string;
  /** Ordered list of milestones that together deliver the full feature. */
  milestones: BlueprintMilestone[];
}

export interface BlueprintValidationError {
  /** Dot-separated path to the offending field, e.g. "milestones[0].title". */
  field: string;
  /** Human-readable explanation of what is wrong and how to fix it. */
  message: string;
}

export type BlueprintParseResult =
  | { ok: true; blueprint: Blueprint }
  | { ok: false; errors: BlueprintValidationError[] };

/**
 * When a task is created from a user-supplied blueprint, this payload is stored
 * alongside the task so the architect enricher can operate in validation mode
 * rather than generation mode.
 */
export interface BlueprintTaskContext {
  /** The raw markdown the user pasted. */
  rawMarkdown: string;
  /** The validated, parsed blueprint (only present when parsing succeeded). */
  blueprint?: Blueprint;
  /** Alias for `blueprint` — the successfully parsed blueprint object. */
  parsed?: Blueprint;
  /** Number of milestones found in the blueprint. */
  milestoneCount?: number;
  /** Task size inferred from the milestone count. */
  inferredSize?: "small" | "medium" | "large";
}
