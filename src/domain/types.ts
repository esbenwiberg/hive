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

// ── Task Filters ────────────────────────────────────────────────────────────

export interface TaskFilters {
  status?: string;
  repoId?: number;
  createdBy?: number;
  search?: string;
}
