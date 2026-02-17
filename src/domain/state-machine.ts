import { TaskStatus } from "./types.js";

// ── Allowed transitions ─────────────────────────────────────────────────────

export const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  [TaskStatus.PENDING]: [
    TaskStatus.QUEUED,
    TaskStatus.CANCELLED,
    TaskStatus.REJECTED,
  ],
  [TaskStatus.QUEUED]: [
    TaskStatus.ENRICHING,
    TaskStatus.CANCELLED,
  ],
  [TaskStatus.ENRICHING]: [
    TaskStatus.READY,
    TaskStatus.FAILED,
    TaskStatus.CANCELLED,
  ],
  [TaskStatus.READY]: [
    TaskStatus.APPROVED,
    TaskStatus.REJECTED,
    TaskStatus.CANCELLED,
  ],
  [TaskStatus.APPROVED]: [
    TaskStatus.EXECUTING,
    TaskStatus.CANCELLED,
  ],
  [TaskStatus.EXECUTING]: [
    TaskStatus.REVIEWING,
    TaskStatus.FAILED,
    TaskStatus.CANCELLED,
  ],
  [TaskStatus.REVIEWING]: [
    TaskStatus.DONE,
    TaskStatus.REWORK,
    TaskStatus.FAILED,
  ],
  [TaskStatus.DONE]: [
    TaskStatus.MERGED,
  ],
  [TaskStatus.MERGED]: [],
  [TaskStatus.FAILED]: [
    TaskStatus.PENDING,
  ],
  [TaskStatus.REJECTED]: [],
  [TaskStatus.CANCELLED]: [],
  [TaskStatus.REWORK]: [
    TaskStatus.EXECUTING,
    TaskStatus.CANCELLED,
  ],
};

// ── Helpers ─────────────────────────────────────────────────────────────────

export function canTransition(from: string, to: string): boolean {
  const targets = ALLOWED_TRANSITIONS[from];
  if (!targets) return false;
  return targets.includes(to);
}

interface Action {
  action: string;
  targetStatus: string;
  label: string;
}

export function getAvailableActions(status: string): Action[] {
  const map: Record<string, Action[]> = {
    [TaskStatus.PENDING]: [
      { action: "queue", targetStatus: TaskStatus.QUEUED, label: "Queue" },
      { action: "cancel", targetStatus: TaskStatus.CANCELLED, label: "Cancel" },
      { action: "reject", targetStatus: TaskStatus.REJECTED, label: "Reject" },
    ],
    [TaskStatus.QUEUED]: [
      { action: "enrich", targetStatus: TaskStatus.ENRICHING, label: "Enrich" },
      { action: "cancel", targetStatus: TaskStatus.CANCELLED, label: "Cancel" },
    ],
    [TaskStatus.ENRICHING]: [
      { action: "mark_ready", targetStatus: TaskStatus.READY, label: "Mark Ready" },
      { action: "fail", targetStatus: TaskStatus.FAILED, label: "Mark Failed" },
      { action: "cancel", targetStatus: TaskStatus.CANCELLED, label: "Cancel" },
    ],
    [TaskStatus.READY]: [
      { action: "approve", targetStatus: TaskStatus.APPROVED, label: "Approve" },
      { action: "reject", targetStatus: TaskStatus.REJECTED, label: "Reject" },
      { action: "cancel", targetStatus: TaskStatus.CANCELLED, label: "Cancel" },
    ],
    [TaskStatus.APPROVED]: [
      { action: "execute", targetStatus: TaskStatus.EXECUTING, label: "Execute" },
      { action: "cancel", targetStatus: TaskStatus.CANCELLED, label: "Cancel" },
    ],
    [TaskStatus.EXECUTING]: [
      { action: "review", targetStatus: TaskStatus.REVIEWING, label: "Review" },
      { action: "fail", targetStatus: TaskStatus.FAILED, label: "Mark Failed" },
      { action: "cancel", targetStatus: TaskStatus.CANCELLED, label: "Cancel" },
    ],
    [TaskStatus.REVIEWING]: [
      { action: "complete", targetStatus: TaskStatus.DONE, label: "Complete" },
      { action: "rework", targetStatus: TaskStatus.REWORK, label: "Rework" },
      { action: "fail", targetStatus: TaskStatus.FAILED, label: "Mark Failed" },
    ],
    [TaskStatus.DONE]: [
      { action: "merge", targetStatus: TaskStatus.MERGED, label: "Merge" },
    ],
    [TaskStatus.FAILED]: [
      { action: "retry", targetStatus: TaskStatus.PENDING, label: "Retry" },
    ],
    [TaskStatus.REWORK]: [
      { action: "execute", targetStatus: TaskStatus.EXECUTING, label: "Execute" },
      { action: "cancel", targetStatus: TaskStatus.CANCELLED, label: "Cancel" },
    ],
  };

  return map[status] ?? [];
}
