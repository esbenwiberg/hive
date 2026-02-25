import type {
  Blueprint,
  BlueprintMilestone,
  BlueprintValidationError,
  ParseResult,
} from "./schema.js";

// ── Regex helpers ─────────────────────────────────────────────────────────────

/**
 * Matches a level-2 heading that starts with "## Approach" (case-insensitive).
 * Everything between this heading and the next ## heading (or end-of-string)
 * is considered the approach section.
 */
const APPROACH_HEADING_RE = /^##\s+approach\b/im;

/**
 * Matches a level-2 heading that starts with "## Milestone" (case-insensitive).
 * The optional trailing number / colon / text is the milestone title.
 *
 * Examples accepted:
 *   ## Milestone 1: Do the thing
 *   ## Milestone 2 — Do the other thing
 *   ## Milestone: Do the thing
 */
const MILESTONE_HEADING_RE = /^##\s+milestone\b/im;

// ── Section splitter ──────────────────────────────────────────────────────────

/**
 * Splits a markdown document into named sections keyed by their ## heading text
 * (lower-cased, trimmed).  The heading line itself is not included in the body.
 */
function splitSections(markdown: string): Map<string, string> {
  const sections = new Map<string, string>();
  // Split on every ## heading (but not ### or deeper)
  const parts = markdown.split(/^(?=##\s)/m);

  for (const part of parts) {
    const firstNewline = part.indexOf("\n");
    if (firstNewline === -1) continue;
    const heading = part.slice(0, firstNewline).replace(/^##\s*/, "").trim().toLowerCase();
    const body = part.slice(firstNewline + 1).trimEnd();
    if (heading) {
      sections.set(heading, body);
    }
  }

  return sections;
}

// ── Approach extraction ───────────────────────────────────────────────────────

function extractApproach(markdown: string): string | null {
  const sections = splitSections(markdown);

  for (const [heading, body] of sections) {
    if (/^approach\b/i.test(heading)) {
      const trimmed = body.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
  }

  return null;
}

// ── Milestone extraction ──────────────────────────────────────────────────────

interface RawMilestoneSection {
  /** The raw heading text after "## Milestone …" */
  headingRemainder: string;
  /** Everything after the heading line. */
  body: string;
}

function extractRawMilestoneSections(markdown: string): RawMilestoneSection[] {
  const results: RawMilestoneSection[] = [];
  // Split on ## headings
  const parts = markdown.split(/^(?=##\s)/m);

  for (const part of parts) {
    const firstNewline = part.indexOf("\n");
    if (firstNewline === -1) continue;
    const headingLine = part.slice(0, firstNewline).trim();
    if (!/^##\s+milestone\b/i.test(headingLine)) continue;

    // Everything after "## Milestone" is the title remainder
    const headingRemainder = headingLine.replace(/^##\s+milestone\s*/i, "").trim();
    const body = part.slice(firstNewline + 1);
    results.push({ headingRemainder, body });
  }

  return results;
}

// ── Sub-section helpers ───────────────────────────────────────────────────────

/**
 * Splits a milestone body into named ### sub-sections.
 */
function splitSubSections(body: string): Map<string, string> {
  const sections = new Map<string, string>();
  const parts = body.split(/^(?=###\s)/m);

  for (const part of parts) {
    const firstNewline = part.indexOf("\n");
    if (firstNewline === -1) continue;
    const heading = part.slice(0, firstNewline).replace(/^###\s*/, "").trim().toLowerCase();
    const content = part.slice(firstNewline + 1).trimEnd();
    if (heading) {
      sections.set(heading, content);
    }
  }

  return sections;
}

/**
 * Extracts the title from the milestone heading remainder.
 * The heading remainder is everything after "## Milestone [N][: —]".
 *
 * Examples:
 *   "1: Do the thing"   → "Do the thing"
 *   "1 — Do the thing"  → "Do the thing"
 *   "1. Do the thing"   → "Do the thing"
 *   "Do the thing"      → "Do the thing"
 *   "1"                 → ""  (number only, no title text)
 */
function parseMilestoneTitle(headingRemainder: string): string {
  // Strip leading number + required separator (colon, dash, en-dash, em-dash, or dot)
  // If the remainder is only a number (no separator and no title text), return "".
  const stripped = headingRemainder
    .replace(/^\d+[\s]*[:\-–—.][\s]*/u, "")
    .trim();
  // If nothing was stripped but the entire remainder is just digits, there is no title
  if (stripped === headingRemainder.trim() && /^\d+$/.test(headingRemainder.trim())) {
    return "";
  }
  return stripped;
}

/**
 * Parses a markdown bullet list into an array of strings.
 * Supports `-`, `*`, and `+` list markers, as well as numbered lists (`1.`).
 * Returns an empty array if there are no list items.
 */
function parseBulletList(text: string): string[] {
  const lines = text.split("\n");
  const items: string[] = [];

  for (const line of lines) {
    const match = line.match(/^\s*(?:[-*+]|\d+\.)\s+(.+)/);
    if (match) {
      // Strip surrounding backticks from inline code (e.g. `src/foo.ts` → src/foo.ts)
      const item = match[1].trim().replace(/^`(.+)`$/, "$1");
      items.push(item);
    }
  }

  return items;
}

/**
 * Extracts plain paragraph text from a section body (ignoring sub-headings and
 * list items so callers can use it for description fields).
 */
function extractParagraphText(body: string): string {
  const lines = body.split("\n");
  const paragraphLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip ### sub-headings
    if (trimmed.startsWith("#")) continue;
    // Skip bullet/numbered list items
    if (/^[-*+]\s/.test(trimmed) || /^\d+\.\s/.test(trimmed)) continue;
    paragraphLines.push(trimmed);
  }

  return paragraphLines.join("\n").trim();
}

// ── Milestone parser ──────────────────────────────────────────────────────────

interface MilestoneParseAttempt {
  milestone?: BlueprintMilestone;
  errors: BlueprintValidationError[];
}

function parseMilestoneSection(
  raw: RawMilestoneSection,
  index: number,
): MilestoneParseAttempt {
  const errors: BlueprintValidationError[] = [];
  const prefix = `milestones[${index}]`;

  // ── Title ─────────────────────────────────────────────────────────────────
  const title = parseMilestoneTitle(raw.headingRemainder);
  if (!title) {
    errors.push({
      field: `${prefix}.title`,
      message: `Milestone ${index + 1} is missing a title. The heading should be "## Milestone ${index + 1}: <Your Title Here>".`,
    });
  }

  const subSections = splitSubSections(raw.body);

  // ── Description ───────────────────────────────────────────────────────────
  let description = "";
  for (const [key, value] of subSections) {
    if (/^description\b/i.test(key)) {
      description = value.trim();
      break;
    }
  }

  // Fallback: treat paragraph text at the top of the body (before any ###) as
  // the description.
  if (!description) {
    const bodyBeforeFirstSubSection = raw.body.split(/^###\s/m)[0];
    description = extractParagraphText(bodyBeforeFirstSubSection).trim();
  }

  if (!description) {
    errors.push({
      field: `${prefix}.description`,
      message: `Milestone ${index + 1} is missing a description. Add a "### Description" sub-section or a paragraph below the milestone heading.`,
    });
  }

  // ── Files to Modify ───────────────────────────────────────────────────────
  let filesToModify: string[] = [];
  for (const [key, value] of subSections) {
    if (/^files?\s*(to\s*modify)?/i.test(key)) {
      filesToModify = parseBulletList(value);
      break;
    }
  }
  // filesToModify is optional — no error if absent

  // ── Acceptance Criteria ───────────────────────────────────────────────────
  let acceptanceCriteria: string[] = [];
  let foundAcSection = false;
  for (const [key, value] of subSections) {
    if (/^acceptance[\s\-]criteria\b/i.test(key)) {
      foundAcSection = true;
      acceptanceCriteria = parseBulletList(value);
      break;
    }
  }

  if (!foundAcSection) {
    errors.push({
      field: `${prefix}.acceptanceCriteria`,
      message: `Milestone ${index + 1} is missing an "### Acceptance Criteria" sub-section.`,
    });
  } else if (acceptanceCriteria.length === 0) {
    errors.push({
      field: `${prefix}.acceptanceCriteria`,
      message: `Milestone ${index + 1} has an "### Acceptance Criteria" section but it contains no list items. Add at least one "- <criterion>" bullet.`,
    });
  }

  if (errors.length > 0) {
    return { errors };
  }

  return {
    milestone: {
      title,
      description,
      filesToModify,
      acceptanceCriteria,
    },
    errors: [],
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Parses a user-supplied markdown blueprint into a structured {@link Blueprint}.
 *
 * Returns `{ ok: true, blueprint }` when the document is valid, or
 * `{ ok: false, errors }` with one or more {@link BlueprintValidationError}
 * entries describing what needs to be fixed.
 */
export function parseBlueprint(markdown: string): ParseResult {
  const errors: BlueprintValidationError[] = [];

  // ── Approach ───────────────────────────────────────────────────────────────
  const approach = extractApproach(markdown);

  if (!APPROACH_HEADING_RE.test(markdown)) {
    errors.push({
      field: "approach",
      message:
        'Blueprint is missing an "## Approach" section. Add a top-level heading "## Approach" followed by your implementation strategy.',
    });
  } else if (!approach) {
    errors.push({
      field: "approach",
      message:
        'The "## Approach" section is empty. Describe your implementation strategy in one or more paragraphs.',
    });
  }

  // ── Milestones ─────────────────────────────────────────────────────────────
  const rawMilestones = extractRawMilestoneSections(markdown);

  if (!MILESTONE_HEADING_RE.test(markdown)) {
    errors.push({
      field: "milestones",
      message:
        'Blueprint is missing at least one "## Milestone" section. Add "## Milestone 1: <title>" followed by description and acceptance criteria.',
    });
  } else if (rawMilestones.length === 0) {
    errors.push({
      field: "milestones",
      message: "Blueprint contains no parseable milestone sections.",
    });
  }

  const milestones: BlueprintMilestone[] = [];

  for (let i = 0; i < rawMilestones.length; i++) {
    const attempt = parseMilestoneSection(rawMilestones[i], i);
    errors.push(...attempt.errors);
    if (attempt.milestone) {
      milestones.push(attempt.milestone);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    blueprint: {
      approach: approach!, // guarded by error check above
      milestones,
    },
  };
}
