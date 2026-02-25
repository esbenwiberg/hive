import { randomBytes } from "node:crypto";

// ── SessionUser ─────────────────────────────────────────────────────────────

export interface SessionUser {
  id: number;
  entraOid: string;
  email: string;
  displayName: string;
  role: string;
}

// ── Task Status (15 states) ─────────────────────────────────────────────────

export const TaskStatus = {
  PENDING: "pending",
  QUEUED: "queued",
  ENRICHING: "enriching",
  ADVISING: "advising",
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

// ── AdvisorReport ────────────────────────────────────────────────────────────

export interface AdvisorReport {
  /** Overall recommendation produced by the advisor agent. */
  recommendation: "approve" | "redesign" | "reject";
  /** Composite quality/fit score from 0 (worst) to 100 (best). */
  score: number;
  /** How confident the advisor is in its recommendation (0–100).
   *  Values below the configured threshold automatically set escalate=true. */
  confidence: number;
  /** Human-readable explanation of the recommendation. */
  reasoning: string;
  /** Specific concerns or observations raised by the advisor. */
  flags: string[];
  /** When true the task must be routed to a human before proceeding. */
  escalate: boolean;
}
