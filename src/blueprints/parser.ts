import type {
  Blueprint,
  BlueprintMilestone,
  BlueprintValidationError,
  BlueprintParseResult,
} from "../domain/types.js";

/**
 * Parses a markdown blueprint string into a structured Blueprint object.
 *
 * Expected format:
 * ```
 * # Approach
 * 
 * High-level implementation strategy shared across all milestones.
 * Can be multiple paragraphs.
 *
 * # Milestone 1: Title
 *
 * ## Description
 * What this milestone achieves.
 *
 * ## Files to Modify
 * - src/path/to/file.ts
 * - src/another/file.ts
 *
 * ## Acceptance Criteria
 * - Criterion 1
 * - Criterion 2
 *
 * # Milestone 2: Title
 * ...
 * ```
 *
 * Returns a structured Blueprint if parsing succeeds, otherwise returns
 * an array of BlueprintValidationError objects explaining what is wrong.
 */
export interface ParseBlueprintOptions {
  /** When true, milestones are required; when false, a small-task format (approach + optional key files/checklist) is accepted. Defaults to true. */
  requireMilestones?: boolean;
}

export function parseBlueprint(markdown: string, options?: ParseBlueprintOptions): BlueprintParseResult {
  const requireMilestones = options?.requireMilestones ?? true;
  const errors: BlueprintValidationError[] = [];

  // Extract approach section
  const approachMatch = markdown.match(/^#+\s+Approach\s*\n([\s\S]*?)(?=^#+\s+Milestone|^#+\s+Key Files|^#+\s+Checklist|(?![\s\S]))/m);
  if (!approachMatch || !approachMatch[1].trim()) {
    errors.push({
      field: "approach",
      message: 'Missing "# Approach" section. This should describe the high-level implementation strategy.',
    });
  }
  const approach = approachMatch ? approachMatch[1].trim() : "";

  // Extract milestones
  const milestonePattern = /^#+\s+Milestone\s+\d+:\s+(.+?)\s*\n([\s\S]*?)(?=^#+\s+Milestone|(?![\s\S]))/gm;
  const milestones: BlueprintMilestone[] = [];
  let match;

  while ((match = milestonePattern.exec(markdown)) !== null) {
    const title = match[1].trim();
    const content = match[2].trim();
    const milestoneNum = milestones.length + 1;

    if (!title) {
      errors.push({
        field: `milestones[${milestones.length}].title`,
        message: `Milestone ${milestoneNum} is missing a title. Use "# Milestone ${milestoneNum}: Title"`,
      });
      continue;
    }

    // Extract description section
    const descMatch = content.match(/^##\s+Description\s*\n([\s\S]*?)(?=^##|(?![\s\S]))/m);
    const description = descMatch ? descMatch[1].trim() : "";

    if (!description) {
      errors.push({
        field: `milestones[${milestones.length}].description`,
        message: `Milestone "${title}" is missing a "## Description" section.`,
      });
    }

    // Extract files to modify section
    const filesMatch = content.match(/^##\s+Files to Modify\s*\n([\s\S]*?)(?=^##|(?![\s\S]))/m);
    const filesText = filesMatch ? filesMatch[1].trim() : "";
    const filesToModify = filesText
      .split("\n")
      .map((line) => line.replace(/^[-*]\s+/, "").trim())
      .filter((line) => line.length > 0);

    if (filesToModify.length === 0) {
      errors.push({
        field: `milestones[${milestones.length}].filesToModify`,
        message: `Milestone "${title}" should list files to modify under "## Files to Modify" (use bullet points).`,
      });
    }

    // Extract acceptance criteria section
    const criteriaMatch = content.match(/^##\s+Acceptance Criteria\s*\n([\s\S]*?)(?=^##|(?![\s\S]))/m);
    const criteriaText = criteriaMatch ? criteriaMatch[1].trim() : "";
    const acceptanceCriteria = criteriaText
      .split("\n")
      .map((line) => line.replace(/^[-*]\s+/, "").trim())
      .filter((line) => line.length > 0);

    if (acceptanceCriteria.length === 0) {
      errors.push({
        field: `milestones[${milestones.length}].acceptanceCriteria`,
        message: `Milestone "${title}" should list acceptance criteria under "## Acceptance Criteria" (use bullet points).`,
      });
    }

    milestones.push({
      title,
      description,
      filesToModify,
      acceptanceCriteria,
    });
  }

  if (milestones.length === 0 && requireMilestones) {
    errors.push({
      field: "milestones",
      message: 'No milestones found. Define at least one milestone using "# Milestone 1: Title" format.',
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // For small-task format (no milestones), extract key files and checklist
  let keyFiles: string[] | undefined;
  let checklist: string[] | undefined;

  if (milestones.length === 0) {
    const keyFilesMatch = markdown.match(/^#+\s+Key Files\s*\n([\s\S]*?)(?=^#+|(?![\s\S]))/m);
    if (keyFilesMatch) {
      keyFiles = keyFilesMatch[1].trim()
        .split("\n")
        .map((line) => line.replace(/^[-*]\s+/, "").replace(/`/g, "").trim())
        .filter((line) => line.length > 0);
    }

    const checklistMatch = markdown.match(/^#+\s+Checklist\s*\n([\s\S]*?)(?=^#+|(?![\s\S]))/m);
    if (checklistMatch) {
      checklist = checklistMatch[1].trim()
        .split("\n")
        .map((line) => line.replace(/^[-*]\s+/, "").trim())
        .filter((line) => line.length > 0);
    }
  }

  return {
    ok: true,
    blueprint: {
      approach,
      milestones,
      keyFiles,
      checklist,
    },
  };
}

/**
 * Infer task size from the number of milestones in a blueprint.
 */
export function inferSizeFromMilestones(
  count: number,
): "small" | "medium" | "large" {
  if (count <= 1) return "small";
  if (count <= 2) return "medium";
  return "large";
}
