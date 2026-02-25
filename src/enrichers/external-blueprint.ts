/**
 * External Blueprint Parser & Validator
 *
 * Parses user-provided Markdown blueprints into the canonical blueprint JSON shape
 * and validates that all required fields are present and well-formed.
 */

// ── Types ────────────────────────────────────────────────────────────────────

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

export interface ParseResult {
  ok: boolean;
  blueprint?: Blueprint;
  errors?: string[];
}

// ── Template ─────────────────────────────────────────────────────────────────

export const BLUEPRINT_MARKDOWN_TEMPLATE = `## Approach

Brief high-level strategy for solving the task.

## Milestones

### Milestone 1: First major piece of work

**Description:**
Detailed explanation of what this milestone accomplishes.

**Files to Modify:**
- src/module/file1.ts
- src/module/file2.ts

**Acceptance Criteria:**
- Criterion 1 is met
- Criterion 2 is implemented
- Criterion 3 is verified

### Milestone 2: Second major piece of work

**Description:**
Detailed explanation of what this milestone accomplishes.

**Files to Modify:**
- src/module/file3.ts
- src/module/file4.ts

**Acceptance Criteria:**
- Criterion 1 is met
- Criterion 2 is implemented
`;

// ── Parser ───────────────────────────────────────────────────────────────────

/**
 * Extracts content between markdown headers.
 * Returns the text between the specified header and the next header at the same level or higher.
 */
function extractSection(markdown: string, headerPattern: RegExp): string | null {
  const headerMatch = markdown.match(headerPattern);
  if (!headerMatch) {
    return null;
  }

  // Find everything after the matched header
  const startIdx = headerMatch.index! + headerMatch[0].length;
  let endIdx = markdown.length;

  // Find the next header at the same level or higher
  const headerLevel = headerMatch[0].match(/#/g)?.length ?? 0;
  const nextHeaderPattern = new RegExp(`^#{1,${headerLevel}}\\s+`, "m");
  const nextHeaderMatch = markdown.substring(startIdx).match(nextHeaderPattern);

  if (nextHeaderMatch) {
    endIdx = startIdx + nextHeaderMatch.index!;
  }

  return markdown.substring(startIdx, endIdx).trim();
}

/**
 * Splits markdown milestone section into individual milestones.
 * Each milestone is introduced by `### Milestone <N>:` or similar h3 header.
 */
function parseMilestones(milestonesSection: string): BlueprintMilestone[] {
  if (!milestonesSection) {
    return [];
  }

  const milestoneBlocks: string[] = [];
  const lines = milestonesSection.split("\n");

  let currentBlock = "";
  for (const line of lines) {
    if (line.match(/^###\s+/)) {
      if (currentBlock) {
        milestoneBlocks.push(currentBlock);
      }
      currentBlock = line + "\n";
    } else {
      currentBlock += line + "\n";
    }
  }
  if (currentBlock) {
    milestoneBlocks.push(currentBlock);
  }

  return milestoneBlocks.map((block) => parseSingleMilestone(block)).filter((m) => m !== null) as BlueprintMilestone[];
}

/**
 * Parses a single markdown milestone block into a BlueprintMilestone.
 * Expected format:
 *   ### Milestone N: Title
 *   **Description:**
 *   ...
 *   **Files to Modify:**
 *   - file1
 *   - file2
 *   **Acceptance Criteria:**
 *   - criterion1
 *   - criterion2
 */
function parseSingleMilestone(block: string): BlueprintMilestone | null {
  // Extract title from the header
  const titleMatch = block.match(/^###\s+Milestone\s+\d+:\s*(.+)$/m);
  if (!titleMatch) {
    return null;
  }
  const title = titleMatch[1].trim();
  if (!title) {
    return null;
  }

  // Extract description (between "Description:" and next "**..." section)
  const descMatch = block.match(/\*\*Description:\*\*\s*([\s\S]*?)(?=\*\*|$)/);
  const description = descMatch ? descMatch[1].trim().replace(/\n+/g, " ") : "";
  if (!description) {
    return null;
  }

  // Extract Files to Modify (list items)
  const filesMatch = block.match(/\*\*Files to Modify:\*\*\s*([\s\S]*?)(?=\*\*|$)/);
  const filesToModify: string[] = [];
  if (filesMatch) {
    const fileLines = filesMatch[1].split("\n");
    for (const line of fileLines) {
      const item = line.replace(/^[-*+]\s+/, "").trim();
      if (item) {
        filesToModify.push(item);
      }
    }
  }

  // Extract Acceptance Criteria (list items)
  const criteriaMatch = block.match(/\*\*Acceptance Criteria:\*\*\s*([\s\S]*?)(?=\*\*|$)/);
  const acceptanceCriteria: string[] = [];
  if (criteriaMatch) {
    const criteriaLines = criteriaMatch[1].split("\n");
    for (const line of criteriaLines) {
      const item = line.replace(/^[-*+]\s+/, "").trim();
      if (item) {
        acceptanceCriteria.push(item);
      }
    }
  }

  if (acceptanceCriteria.length === 0) {
    return null;
  }

  return {
    title,
    description,
    filesToModify,
    acceptanceCriteria,
  };
}

/**
 * Parses a Markdown string into the canonical blueprint JSON shape.
 * Returns { ok: true, blueprint } on success or { ok: false, errors } on failure.
 */
export function parseMarkdownBlueprint(markdown: string): ParseResult {
  if (!markdown || typeof markdown !== "string") {
    return {
      ok: false,
      errors: ["Blueprint must be a non-empty string"],
    };
  }

  const errors: string[] = [];

  // Extract Approach section
  const approachText = extractSection(markdown, /^##\s+Approach\s*$/m);
  if (!approachText) {
    errors.push("Missing required section: '## Approach'");
  }
  const approach = approachText?.trim() || "";
  if (!approach) {
    errors.push("'Approach' section is empty");
  }

  // Extract Milestones section
  const milestonesText = extractSection(markdown, /^##\s+Milestones\s*$/m);
  if (!milestonesText) {
    errors.push("Missing required section: '## Milestones'");
  }

  const milestones = milestonesText ? parseMilestones(milestonesText) : [];
  if (milestones.length === 0) {
    errors.push("'Milestones' section must contain at least one milestone");
  }

  if (errors.length > 0) {
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
