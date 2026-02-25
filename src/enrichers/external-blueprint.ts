import type { Blueprint, BlueprintMilestone } from "../domain/types.js";

/**
 * Canonical Markdown template for external blueprints.
 * Users copy this and fill in their approach and milestones.
 */
export const BLUEPRINT_MARKDOWN_TEMPLATE = `# Approach

Describe the overall strategy and approach to solving this task.

## Milestones

### Milestone 1: Title

**Description:**
Clear description of what this milestone accomplishes.

**Files to Modify:**
- src/file1.ts
- src/file2.ts

**Acceptance Criteria:**
- Clear, testable criterion 1
- Clear, testable criterion 2

### Milestone 2: Title

**Description:**
Clear description of what this milestone accomplishes.

**Files to Modify:**
- src/file3.ts

**Acceptance Criteria:**
- Clear, testable criterion 1
`;

/**
 * Result of parsing and validating a Markdown blueprint.
 */
export interface ParseResult {
  ok: boolean;
  blueprint?: Blueprint;
  errors?: string[];
}

/**
 * Parses a Markdown blueprint string into the canonical JSON shape.
 * Returns either a valid Blueprint or a list of human-readable errors.
 *
 * Expected format:
 * # Approach
 * <approach text>
 *
 * ## Milestones
 *
 * ### Milestone <N>: <Title>
 *
 * **Description:**
 * <description>
 *
 * **Files to Modify:**
 * - file1
 * - file2
 *
 * **Acceptance Criteria:**
 * - criterion 1
 * - criterion 2
 */
export function parseMarkdownBlueprint(markdown: string): ParseResult {
  const errors: string[] = [];

  // Extract approach section (between "# Approach" and "## Milestones")
  const approachMatch = markdown.match(
    /^#\s+Approach\s*\n([\s\S]*?)^##\s+Milestones/m,
  );
  if (!approachMatch) {
    errors.push("Missing '# Approach' section or '## Milestones' header");
    return { ok: false, errors };
  }

  const approach = approachMatch[1].trim();
  if (!approach) {
    errors.push("Approach section is empty");
    return { ok: false, errors };
  }

  // Extract milestones section (everything after "## Milestones")
  const milestonesMatch = markdown.match(/^##\s+Milestones\s*\n([\s\S]*)$/m);
  if (!milestonesMatch) {
    errors.push("Missing '## Milestones' section");
    return { ok: false, errors };
  }

  const milestonesText = milestonesMatch[1];

  // Split milestones by "### Milestone"
  const milestoneBlocks = milestonesText.split(/^###\s+Milestone\s+/m);
  // First element is empty (before the first milestone), so skip it
  milestoneBlocks.shift();

  if (milestoneBlocks.length === 0) {
    errors.push(
      "No milestones found. Each milestone should start with '### Milestone N: Title'",
    );
    return { ok: false, errors };
  }

  const milestones: BlueprintMilestone[] = [];

  for (let i = 0; i < milestoneBlocks.length; i++) {
    const block = milestoneBlocks[i];
    const milestoneErrors = parseMilestoneBlock(block, i + 1);
    if (milestoneErrors.hasError) {
      errors.push(...milestoneErrors.messages);
      continue;
    }
    if (milestoneErrors.milestone) {
      milestones.push(milestoneErrors.milestone);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  if (milestones.length === 0) {
    errors.push("No valid milestones could be parsed");
    return { ok: false, errors };
  }

  return {
    ok: true,
    blueprint: {
      approach,
      milestones,
    },
  };
}

/**
 * Parses a single milestone block.
 * Returns validation errors and the parsed milestone if successful.
 */
function parseMilestoneBlock(
  block: string,
  index: number,
): {
  hasError: boolean;
  messages: string[];
  milestone?: BlueprintMilestone;
} {
  const errors: string[] = [];

  // Extract title from "N: Title" format
  const titleMatch = block.match(/^(\d+):\s*(.+)\n/);
  if (!titleMatch) {
    errors.push(`Milestone ${index}: Invalid title format. Expected 'N: Title'`);
    return { hasError: true, messages: errors };
  }

  const title = titleMatch[2].trim();
  if (!title) {
    errors.push(`Milestone ${index}: Title cannot be empty`);
    return { hasError: true, messages: errors };
  }

  // Extract description (between "**Description:**" and next section)
  const descMatch = block.match(
    /\*\*Description:\*\*\s*\n([\s\S]*?)(?:\*\*Files to Modify:\*\*|$)/,
  );
  if (!descMatch) {
    errors.push(
      `Milestone '${title}': Missing or malformed '**Description:**' section`,
    );
    return { hasError: true, messages: errors };
  }

  const description = descMatch[1]
    .trim()
    .split("\n")
    .filter((l) => l.trim())
    .join(" ");
  if (!description) {
    errors.push(`Milestone '${title}': Description cannot be empty`);
    return { hasError: true, messages: errors };
  }

  // Extract files to modify (bullet points after "**Files to Modify:**")
  const filesMatch = block.match(
    /\*\*Files to Modify:\*\*\s*\n([\s\S]*?)(?:\*\*Acceptance Criteria:\*\*|$)/,
  );
  if (!filesMatch) {
    errors.push(
      `Milestone '${title}': Missing or malformed '**Files to Modify:**' section`,
    );
    return { hasError: true, messages: errors };
  }

  const filesToModify = extractBulletList(filesMatch[1]);
  if (filesToModify.length === 0) {
    errors.push(
      `Milestone '${title}': 'Files to Modify' list cannot be empty. Use bullet points like '- file.ts'`,
    );
    return { hasError: true, messages: errors };
  }

  // Extract acceptance criteria (bullet points after "**Acceptance Criteria:**")
  const criteriaMatch = block.match(/\*\*Acceptance Criteria:\*\*\s*\n([\s\S]*?)$/);
  if (!criteriaMatch) {
    errors.push(
      `Milestone '${title}': Missing or malformed '**Acceptance Criteria:**' section`,
    );
    return { hasError: true, messages: errors };
  }

  const acceptanceCriteria = extractBulletList(criteriaMatch[1]);
  if (acceptanceCriteria.length === 0) {
    errors.push(
      `Milestone '${title}': 'Acceptance Criteria' cannot be empty. Use bullet points like '- Criterion text'`,
    );
    return { hasError: true, messages: errors };
  }

  return {
    hasError: false,
    messages: [],
    milestone: {
      title,
      description,
      filesToModify,
      acceptanceCriteria,
    },
  };
}

/**
 * Extracts bullet-point items from a text block.
 * Handles "- Item" format and strips whitespace.
 */
function extractBulletList(text: string): string[] {
  const lines = text.split("\n");
  const items: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) {
      const item = trimmed.substring(2).trim();
      if (item) {
        items.push(item);
      }
    }
  }

  return items;
}
