/**
 * External blueprint parser & validator.
 *
 * Allows users to paste a Markdown-formatted blueprint (produced outside the
 * hive, e.g. via a terminal conversation) and have it converted into the
 * canonical `Blueprint` JSON shape consumed by the rest of the pipeline.
 *
 * Expected Markdown structure
 * ───────────────────────────
 * # Approach
 * <one or more paragraphs>
 *
 * ## Milestones
 *
 * ### <Milestone title>
 * <description paragraphs>
 *
 * **Files to modify**
 * - path/to/file.ts
 *
 * **Acceptance criteria**
 * - Criterion one
 */

// ── Canonical types ──────────────────────────────────────────────────────────

export interface BlueprintMilestone {
  title: string;
  description: string;
  filesToModify: string[];
  acceptanceCriteria: string[];
}

export interface Blueprint {
  approach: string;
  milestones: BlueprintMilestone[];
}

// ── Parse result ─────────────────────────────────────────────────────────────

export type ParseResult =
  | { ok: true; blueprint: Blueprint }
  | { ok: false; errors: string[] };

// ── Markdown template ────────────────────────────────────────────────────────

/**
 * Canonical Markdown template shown on the "submit external blueprint" form.
 * This string is guaranteed to parse successfully through `parseMarkdownBlueprint`.
 */
export const BLUEPRINT_MARKDOWN_TEMPLATE = `# Approach

Describe the high-level implementation strategy here. Explain the overall
design decisions and why this approach was chosen.

## Milestones

### 1. Example milestone title

Describe what this milestone accomplishes and any important implementation
details the worker agent needs to know.

**Files to modify**
- src/example/module.ts
- src/example/index.ts

**Acceptance criteria**
- The module exports a \`doThing()\` function that returns the expected value
- Unit tests pass for the happy path and the error case
`;

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Splits a Markdown document into named sections.
 *
 * Accepts two layout conventions:
 *
 *   Convention A (flat H1 headings):
 *     # Approach … # Milestones … ### Milestone title
 *
 *   Convention B (nested, H1 + H2 + H3):
 *     # Approach … ## Milestones … ### Milestone title
 *
 * Returns a map keyed by lowercased heading text, with each value being the
 * raw text body that follows the heading.
 */
function splitTopLevelSections(markdown: string): Map<string, string> {
  const sections = new Map<string, string>();

  // Split on any H1 or H2 heading line (but not H3+ which are milestone titles)
  const parts = markdown.split(/^(?=#{1,2}\s)/m).filter(Boolean);
  const headingPattern = /^(#{1,2})\s+(.+)$/m;

  for (const part of parts) {
    const headingMatch = headingPattern.exec(part);
    if (!headingMatch) continue;
    const heading = headingMatch[2].trim().toLowerCase();
    const body = part.slice(headingMatch[0].length).trim();
    sections.set(heading, body);
  }

  return sections;
}

/**
 * Within a "Milestones" section body, split on H3 headings (`### …`) to get
 * individual milestone blocks.
 */
function splitMilestoneBlocks(body: string): Array<{ title: string; content: string }> {
  const blocks: Array<{ title: string; content: string }> = [];
  const parts = body.split(/^(?=###\s)/m).filter(Boolean);

  for (const part of parts) {
    const headingMatch = /^###\s+(.+)$/m.exec(part);
    if (!headingMatch) continue;
    const title = headingMatch[1].trim();
    const content = part.slice(headingMatch[0].length).trim();
    blocks.push({ title, content });
  }

  return blocks;
}

/**
 * Extracts a bullet list that immediately follows a bold label such as
 * `**Files to modify**` or `**Acceptance criteria**`.
 *
 * Uses a line-by-line parser to correctly handle bold text (`**text**`)
 * appearing inside bullet items (e.g., `- **Important** note`). Returns an
 * empty array when the label is absent.
 *
 * Algorithm:
 * 1. Find the bold label line using regex (line that is entirely bold)
 * 2. From the line after the label, collect all lines that start with a bullet marker (-, *, •)
 * 3. Stop when we hit a blank line or a NEW BOLD LABEL (entire line is bold, e.g., `**Section Title**`)
 * 4. For each bullet line, strip the leading marker and whitespace, keep trailing text
 * 5. Handle multi-line bullet items by joining indented continuation lines
 *
 * A section boundary is defined as a line where the entire trimmed content
 * matches `^\*\*[^*]+\*\*$` (entirely bold, nothing else).
 */
function extractBulletList(content: string, labelPattern: RegExp): string[] {
  const match = labelPattern.exec(content);
  if (!match) return [];

  const lines = content.split("\n");

  // Find the line containing the label
  let labelLineIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (labelPattern.test(lines[i])) {
      labelLineIndex = i;
      break;
    }
  }

  if (labelLineIndex === -1) return [];

  const items: string[] = [];
  let inBulletList = false;

  // Process lines after the label line
  for (let i = labelLineIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Empty line ends the list
    if (!trimmed) {
      if (inBulletList) break;
      continue;
    }

    // NEW BOLD LABEL (entire line is bold) ends the list.
    // This pattern matches lines like `**Section Title**` or `**Files to modify**`
    // but NOT `- **Important** note` (which has non-bold content).
    if (/^\*\*[^*]+\*\*$/.test(trimmed)) {
      break;
    }

    // Check if line is a bullet item (starts with -, *, •, or whitespace + bullet)
    const bulletMatch = /^[\s]*([-*•])\s+(.*)$/.exec(line);
    if (bulletMatch) {
      inBulletList = true;
      const item = bulletMatch[2].trim();
      if (item) {
        items.push(item);
      }
    } else if (inBulletList && line.match(/^\s+/)) {
      // Continuation of previous item (indented line after a bullet)
      const continuation = trimmed;
      if (continuation && items.length > 0) {
        items[items.length - 1] += " " + continuation;
      }
    } else if (inBulletList) {
      // Non-bullet, non-indented line ends the list
      break;
    }
  }

  return items;
}

/**
 * Extracts the description text from a milestone block — everything before the
 * first bold label (`**…**`).
 */
function extractDescription(content: string): string {
  const boldLabelIndex = content.search(/\*\*[^*]+\*\*/m);
  const raw = boldLabelIndex === -1 ? content : content.slice(0, boldLabelIndex);
  return raw.trim();
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Parses a Markdown string into the canonical `Blueprint` shape.
 *
 * Returns `{ ok: true, blueprint }` on success, or
 * `{ ok: false, errors }` with human-readable messages on failure.
 */
export function parseMarkdownBlueprint(markdown: string): ParseResult {
  const errors: string[] = [];

  if (!markdown || !markdown.trim()) {
    return { ok: false, errors: ["Blueprint is empty. Please provide Markdown content."] };
  }

  // ── Top-level sections ──────────────────────────────────────────────────
  const topLevel = splitTopLevelSections(markdown);

  // ── Approach ────────────────────────────────────────────────────────────
  const approachKey = [...topLevel.keys()].find((k) => k === "approach");
  const approachText = approachKey !== undefined ? topLevel.get(approachKey)! : "";

  if (!approachKey) {
    errors.push(
      'Missing required section: "# Approach". Add an H1 or H2 heading named "Approach" followed by your implementation strategy.',
    );
  } else if (!approachText.trim()) {
    errors.push(
      'The "Approach" section is present but contains no content. Describe the implementation strategy.',
    );
  }

  // ── Milestones section ──────────────────────────────────────────────────
  const milestonesKey = [...topLevel.keys()].find((k) => k === "milestones");
  const milestonesBody = milestonesKey !== undefined ? topLevel.get(milestonesKey)! : "";

  if (!milestonesKey) {
    errors.push(
      'Missing required section: "Milestones". Add an H1 or H2 heading named "Milestones" containing at least one "### <title>" sub-section.',
    );
    // Cannot validate individual milestones without the section
    if (errors.length > 0) return { ok: false, errors };
  }

  // ── Individual milestones ───────────────────────────────────────────────
  const milestoneBlocks = splitMilestoneBlocks(milestonesBody);

  if (milestoneBlocks.length === 0) {
    errors.push(
      'The "# Milestones" section contains no milestones. Add at least one milestone using a "### <title>" sub-heading.',
    );
  }

  const parsedMilestones: BlueprintMilestone[] = [];

  for (let i = 0; i < milestoneBlocks.length; i++) {
    const { title, content } = milestoneBlocks[i];
    const prefix = `Milestone ${i + 1} ("${title}")`;
    const milestoneErrors: string[] = [];

    const description = extractDescription(content);
    if (!description) {
      milestoneErrors.push(`${prefix}: missing description. Add a paragraph of text after the milestone heading.`);
    }

    const filesToModify = extractBulletList(
      content,
      /\*\*Files?\s+to\s+modify\*\*/i,
    );
    if (filesToModify.length === 0) {
      milestoneErrors.push(
        `${prefix}: missing "**Files to modify**" bullet list. List the files the worker should change.`,
      );
    }

    const acceptanceCriteria = extractBulletList(
      content,
      /\*\*Acceptance\s+criteria\*\*/i,
    );
    if (acceptanceCriteria.length === 0) {
      milestoneErrors.push(
        `${prefix}: missing "**Acceptance criteria**" bullet list. List at least one testable criterion.`,
      );
    }

    if (milestoneErrors.length > 0) {
      errors.push(...milestoneErrors);
    } else {
      parsedMilestones.push({
        title,
        description,
        filesToModify,
        acceptanceCriteria,
      });
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    blueprint: {
      approach: approachText.trim(),
      milestones: parsedMilestones,
    },
  };
}
