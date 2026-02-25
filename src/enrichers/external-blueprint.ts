import type { Blueprint, BlueprintMilestone } from "../domain/types.js";

// Re-export Blueprint type for convenience
export type { Blueprint } from "../domain/types.js";

/**
 * Result of parsing a Markdown blueprint.
 * Either a successfully parsed Blueprint or a list of validation errors.
 */
export interface ParseResult {
  ok: boolean;
  blueprint?: Blueprint;
  errors?: string[];
}

/**
 * The canonical Markdown template for external blueprints.
 * Users should use this as a reference when submitting blueprints directly.
 */
export const BLUEPRINT_MARKDOWN_TEMPLATE = `# Approach
Provide a clear, high-level implementation strategy. Explain the core idea and why this approach is chosen.

# Milestones

## Milestone 1: First major work unit
Brief description of what is completed in this milestone.

**Files to modify:**
- src/example/file1.ts
- src/example/file2.ts

**Acceptance criteria:**
- [ ] Acceptance criterion 1
- [ ] Acceptance criterion 2
- [ ] Acceptance criterion 3

## Milestone 2: Second major work unit
Brief description of the next milestone.

**Files to modify:**
- src/example/file3.ts
- docs/example.md

**Acceptance criteria:**
- [ ] Another criterion 1
- [ ] Another criterion 2
`;

/**
 * Parses a Markdown blueprint string into a typed Blueprint object.
 *
 * Validates:
 * - The `# Approach` section exists and is non-empty
 * - The `# Milestones` section exists
 * - Each milestone has: title, description, filesToModify, acceptanceCriteria
 * - Each milestone's fields are properly formatted
 *
 * Returns { ok: true, blueprint } on success.
 * Returns { ok: false, errors: [...] } on failure with descriptive error messages.
 */
export function parseMarkdownBlueprint(markdown: string): ParseResult {
  if (!markdown || typeof markdown !== "string" || markdown.trim().length === 0) {
    return {
      ok: false,
      errors: ["Blueprint cannot be empty"],
    };
  }

  const errors: string[] = [];

  // ── Parse approach section ──────────────────────────────────────────────

  const approachMatch = markdown.match(/^#\s+Approach\s*\n([\s\S]*?)(?=^#\s+|$)/m);
  const approach = approachMatch
    ? approachMatch[1].trim()
    : "";

  if (!approach) {
    errors.push('Missing or empty "# Approach" section');
  }

  // ── Parse milestones section ────────────────────────────────────────────

  const milestonesMatch = markdown.match(
    /^#\s+Milestones\s*\n([\s\S]*?)$/m,
  );
  if (!milestonesMatch) {
    errors.push('Missing "# Milestones" section');
  }

  // If we already have critical errors, return early
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const milestonesText = milestonesMatch ? milestonesMatch[1] : "";

  // Split by milestone headers (## Milestone N)
  const milestoneBlocks = milestonesText
    .split(/^##\s+/m)
    .slice(1); // Skip the empty first element before the first ##

  if (milestoneBlocks.length === 0) {
    return {
      ok: false,
      errors: ['No milestones found under "# Milestones" section'],
    };
  }

  const milestones: BlueprintMilestone[] = [];

  for (let i = 0; i < milestoneBlocks.length; i++) {
    const blockText = milestoneBlocks[i];
    const blockNum = i + 1;

    // Extract milestone title (first line)
    const titleMatch = blockText.match(/^([^\n]+)/);
    const title = titleMatch ? titleMatch[1].trim() : `Milestone ${blockNum}`;

    if (!title || title.length === 0) {
      errors.push(`Milestone ${blockNum}: missing or empty title`);
      continue;
    }

    // Extract description (text before "Files to modify:" or "Acceptance criteria:")
    const descMatch = blockText.match(
      /^[^\n]+\n([\s\S]*?)(?=\*\*Files to modify:|$)/i,
    );
    const description = descMatch
      ? descMatch[1].trim()
      : "";

    if (!description) {
      errors.push(`Milestone ${blockNum} (${title}): missing or empty description`);
      continue;
    }

    // Extract filesToModify
    const filesMatch = blockText.match(
      /\*\*Files to modify:\*\*\s*\n([\s\S]*?)(?=\*\*Acceptance criteria:|$)/i,
    );
    const filesText = filesMatch ? filesMatch[1] : "";
    const filesToModify = filesText
      .split("\n")
      .map((line) => line.replace(/^[-*]\s+/, "").trim())
      .filter((f) => f.length > 0);

    if (filesToModify.length === 0) {
      errors.push(
        `Milestone ${blockNum} (${title}): missing or empty "Files to modify" list`,
      );
      continue;
    }

    // Extract acceptanceCriteria
    const acMatch = blockText.match(
      /\*\*Acceptance criteria:\*\*\s*\n([\s\S]*?)$/i,
    );
    const acText = acMatch ? acMatch[1] : "";
    const acceptanceCriteria = acText
      .split("\n")
      .map((line) => line.replace(/^[-*]\s+\[\s*\]\s+/, "").trim())
      .filter((c) => c.length > 0);

    if (acceptanceCriteria.length === 0) {
      errors.push(
        `Milestone ${blockNum} (${title}): missing or empty "Acceptance criteria" list`,
      );
      continue;
    }

    milestones.push({
      title,
      description,
      filesToModify,
      acceptanceCriteria,
    });
  }

  // Return early if we found errors while parsing milestones
  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // ── Return successful parse ─────────────────────────────────────────────

  return {
    ok: true,
    blueprint: {
      approach,
      milestones,
    },
  };
}
