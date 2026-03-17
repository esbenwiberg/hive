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
    TaskStatus.FAILED,
    TaskStatus.CANCELLED,
    TaskStatus.SUSPENDED,
  ],
  [TaskStatus.ENRICHING]: [
    TaskStatus.PENDING,
    TaskStatus.READY,
    TaskStatus.APPROVED,
    TaskStatus.REJECTED,
    TaskStatus.REWORK,
    TaskStatus.FAILED,
    TaskStatus.CANCELLED,
    TaskStatus.SUSPENDED,
  ],
  [TaskStatus.READY]: [
    TaskStatus.PENDING,
    TaskStatus.ENRICHING,
    TaskStatus.APPROVED,
    TaskStatus.REJECTED,
    TaskStatus.CANCELLED,
  ],
  [TaskStatus.APPROVED]: [
    TaskStatus.EXECUTING,
    TaskStatus.FAILED,
    TaskStatus.CANCELLED,
  ],
  [TaskStatus.EXECUTING]: [
    TaskStatus.REVIEWING,
    TaskStatus.APPROVED,
    TaskStatus.REWORK,
    TaskStatus.FAILED,
    TaskStatus.CANCELLED,
    TaskStatus.SUSPENDED,
  ],
  [TaskStatus.REVIEWING]: [
    TaskStatus.DONE,
    TaskStatus.REWORK,
    TaskStatus.FAILED,
    TaskStatus.SUSPENDED,
  ],
  [TaskStatus.DONE]: [
    TaskStatus.MERGED,
    TaskStatus.REWORK,
  ],
  [TaskStatus.MERGED]: [],
  [TaskStatus.FAILED]: [
    TaskStatus.PENDING,
    TaskStatus.APPROVED,
    TaskStatus.REWORK,
    TaskStatus.REVIEWING,
    TaskStatus.DONE,
    TaskStatus.CANCELLED,
  ],
  [TaskStatus.REJECTED]: [],
  [TaskStatus.CANCELLED]: [
    TaskStatus.PENDING,
  ],
  [TaskStatus.REWORK]: [
    TaskStatus.EXECUTING,
    TaskStatus.FAILED,
    TaskStatus.CANCELLED,
  ],
  [TaskStatus.SUSPENDED]: [
    TaskStatus.PENDING,
    TaskStatus.APPROVED,
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
      { action: "retry", targetStatus: TaskStatus.PENDING, label: "Retry" },
      { action: "fail", targetStatus: TaskStatus.FAILED, label: "Mark Failed" },
      { action: "cancel", targetStatus: TaskStatus.CANCELLED, label: "Cancel" },
    ],
    [TaskStatus.READY]: [
      { action: "enrich", targetStatus: TaskStatus.ENRICHING, label: "Re-enrich" },
      { action: "approve", targetStatus: TaskStatus.APPROVED, label: "Approve" },
      { action: "reject", targetStatus: TaskStatus.REJECTED, label: "Reject" },
      { action: "cancel", targetStatus: TaskStatus.CANCELLED, label: "Cancel" },
    ],
    [TaskStatus.APPROVED]: [
      { action: "cancel", targetStatus: TaskStatus.CANCELLED, label: "Cancel" },
    ],
    [TaskStatus.EXECUTING]: [
      { action: "review", targetStatus: TaskStatus.REVIEWING, label: "Review" },
      { action: "reapprove", targetStatus: TaskStatus.APPROVED, label: "Re-approve" },
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
      { action: "pr_rework", targetStatus: TaskStatus.REWORK, label: "PR Rework" },
    ],
    [TaskStatus.FAILED]: [
      { action: "accept_browser_validation", targetStatus: TaskStatus.DONE, label: "Accept & Create PR" },
      { action: "force_pr", targetStatus: TaskStatus.DONE, label: "Force PR" },
      { action: "more_cycles", targetStatus: TaskStatus.REWORK, label: "More Cycles" },
      { action: "redesign", targetStatus: TaskStatus.APPROVED, label: "Redesign" },
      { action: "continue", targetStatus: TaskStatus.APPROVED, label: "Continue" },
      { action: "retry", targetStatus: TaskStatus.PENDING, label: "Retry" },
    ],
    [TaskStatus.CANCELLED]: [
      { action: "retry", targetStatus: TaskStatus.PENDING, label: "Retry" },
    ],
    [TaskStatus.REWORK]: [
      { action: "cancel", targetStatus: TaskStatus.CANCELLED, label: "Cancel" },
    ],
    [TaskStatus.SUSPENDED]: [
      { action: "resume", targetStatus: TaskStatus.PENDING, label: "Resume" },
      { action: "cancel", targetStatus: TaskStatus.CANCELLED, label: "Cancel" },
    ],
  };

  return map[status] ?? [];
}

/**
 * Returns all valid transition targets not already covered by `getAvailableActions()`.
 * Used for the "Move to..." dropdown in the UI.
 */
export function getAllowedTargets(status: string): { status: string; label: string }[] {
  const curatedTargets = new Set(getAvailableActions(status).map((a) => a.targetStatus));
  const allTargets = ALLOWED_TRANSITIONS[status] ?? [];

  const labels: Record<string, string> = {
    [TaskStatus.PENDING]: "Pending",
    [TaskStatus.QUEUED]: "Queued",
    [TaskStatus.ENRICHING]: "Enriching",
    [TaskStatus.READY]: "Ready",
    [TaskStatus.APPROVED]: "Approved",
    [TaskStatus.EXECUTING]: "Executing",
    [TaskStatus.REVIEWING]: "Reviewing",
    [TaskStatus.DONE]: "Done",
    [TaskStatus.MERGED]: "Merged",
    [TaskStatus.FAILED]: "Failed",
    [TaskStatus.REJECTED]: "Rejected",
    [TaskStatus.CANCELLED]: "Cancelled",
    [TaskStatus.REWORK]: "Rework",
    [TaskStatus.SUSPENDED]: "Suspended",
  };

  return allTargets
    .filter((t) => !curatedTargets.has(t))
    .map((t) => ({ status: t, label: labels[t] ?? t }));
}
