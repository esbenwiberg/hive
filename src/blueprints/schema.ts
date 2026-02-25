// ── Blueprint Types ───────────────────────────────────────────────────────────
//
// These types represent the canonical Hive Blueprint format — the structured
// shape that a user-supplied markdown blueprint is parsed into.

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

export type ParseResult =
  | { ok: true; blueprint: Blueprint }
  | { ok: false; errors: BlueprintValidationError[] };
