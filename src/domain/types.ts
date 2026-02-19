import { randomBytes } from "node:crypto";

// ── SessionUser ─────────────────────────────────────────────────────────────

export interface SessionUser {
  id: number;
  entraOid: string;
  email: string;
  displayName: string;
  role: string;
}

// ── Task Status (13 states) ─────────────────────────────────────────────────

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
  const hex = randomBytes(2).toString("hex"); // 4 hex chars
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

// ── Task Filters ────────────────────────────────────────────────────────────

export interface TaskFilters {
  status?: string;
  statuses?: string[];
  repoId?: number;
  createdBy?: number;
  search?: string;
}

// ── Execution Types ────────────────────────────────────────────────────────

export interface WorktreeInfo {
  path: string;
  branch: string;
  repoFullName: string;
  provider: string;
  createdAt: Date;
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
