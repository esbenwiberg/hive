import type { Blueprint, BlueprintValidationError, BlueprintParseResult } from "../domain/types.js";

/**
 * Parses a markdown blueprint string into a structured Blueprint object.
 *
 * The expected format is:
 *
 * ```markdown
 * # Implementation Plan
 *
 * ## Approach
 *
 * <One or more paragraphs describing the implementation strategy.>
 *
 * ## Milestones
 *
 * ### Milestone 1: <Title>
 *
 * <Description paragraph(s).>
 *
 * **Files to modify:**
 * - src/file1.ts
 * - src/file2.ts
 *
 * **Acceptance criteria:**
 * - [ ] First criterion
 * - [ ] Second criterion
 *
 * ### Milestone 2: <Title>
 * ...
 * ```
 *
 * Returns `{ ok: true; blueprint }` on success, or `{ ok: false; errors }` if:
 * - No "## Approach" section exists
 * - No "## Milestones" section exists
 * - No milestones (h3 sections) are found
 * - Any milestone is missing required parts (title, description, files, criteria)
 */
export function parseBlueprint(markdown: string): BlueprintParseResult {
  const errors: BlueprintValidationError[] = [];

  // ── Normalize newlines and split into lines ────────────────────────────
  const lines = markdown.split(/\r?\n/);

  // ── Extract approach section ──────────────────────────────────────────
  let approach = "";
  let approachStart = -1;
  let milestonesStart = -1;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].match(/^##\s+Approach/i)) {
      approachStart = i + 1;
    }
    if (lines[i].match(/^##\s+Milestones/i)) {
      milestonesStart = i + 1;
      break;
    }
  }

  if (approachStart === -1) {
    errors.push({
      field: "approach",
      message:
        'Missing "## Approach" section. Add a section titled "## Approach" with your implementation strategy.',
    });
    return { ok: false, errors };
  }

  if (milestonesStart === -1) {
    errors.push({
      field: "milestones",
      message:
        'Missing "## Milestones" section. Add a section titled "## Milestones" with one or more milestones (h3 headers starting with "### ").',
    });
    return { ok: false, errors };
  }

  // Extract approach text (everything from "## Approach" to "## Milestones")
  const approachLines: string[] = [];
  for (let i = approachStart; i < milestonesStart; i++) {
    // Skip the header line itself; grab text until the next ## section
    if (!lines[i].match(/^##/)) {
      approachLines.push(lines[i]);
    }
  }
  approach = approachLines
    .join("\n")
    .trim()
    .replace(/^\s*[\r\n]/gm, "") // Remove leading blank lines
    .replace(/[\r\n]\s*$/gm, ""); // Remove trailing blank lines

  if (!approach) {
    errors.push({
      field: "approach",
      message: "Approach section is empty. Add one or more paragraphs describing your implementation strategy.",
    });
    return { ok: false, errors };
  }

  // ── Extract milestones (h3 sections) ──────────────────────────────────
  const milestones: Array<{ title: string; lines: string[] }> = [];
  let currentMilestoneTitle = "";
  let currentMilestoneLines: string[] = [];

  for (let i = milestonesStart; i < lines.length; i++) {
    const line = lines[i];

    // Check for h3 (milestone title)
    const h3Match = line.match(/^###\s+(?:Milestone\s+\d+:\s*)?(.+)$/i);
    if (h3Match) {
      // Save the previous milestone
      if (currentMilestoneTitle) {
        milestones.push({
          title: currentMilestoneTitle,
          lines: currentMilestoneLines,
        });
      }
      currentMilestoneTitle = h3Match[1].trim();
      currentMilestoneLines = [];
    } else {
      // Accumulate lines under the current milestone
      currentMilestoneLines.push(line);
    }
  }

  // Save the last milestone
  if (currentMilestoneTitle) {
    milestones.push({
      title: currentMilestoneTitle,
      lines: currentMilestoneLines,
    });
  }

  if (milestones.length === 0) {
    errors.push({
      field: "milestones",
      message:
        'No milestones found. Add one or more milestone sections using h3 headers: "### Milestone 1: <Title>".',
    });
    return { ok: false, errors };
  }

  // ── Parse each milestone ──────────────────────────────────────────────
  const parsedMilestones: Blueprint["milestones"] = [];

  for (let idx = 0; idx < milestones.length; idx++) {
    const { title, lines: milestoneLines } = milestones[idx];
    const fieldPrefix = `milestones[${idx}]`;

    if (!title) {
      errors.push({
        field: `${fieldPrefix}.title`,
        message: "Milestone title is empty.",
      });
      continue;
    }

    // Extract description (all text until "**Files to modify:**" or "**Acceptance criteria:**")
    let description = "";
    let filesStart = -1;
    let criteriaStart = -1;

    for (let i = 0; i < milestoneLines.length; i++) {
      if (milestoneLines[i].match(/^\*\*Files?\s+to\s+modify:\*\*/i)) {
        filesStart = i;
        break;
      }
      if (milestoneLines[i].match(/^\*\*Acceptance\s+criteria:\*\*/i)) {
        criteriaStart = i;
        break;
      }
    }

    if (filesStart === -1 && criteriaStart === -1) {
      // No structured sections found; treat all as description
      description = milestoneLines
        .join("\n")
        .trim()
        .replace(/^\s*[\r\n]/gm, "")
        .replace(/[\r\n]\s*$/gm, "");
    } else {
      const descEnd = filesStart >= 0 ? filesStart : criteriaStart >= 0 ? criteriaStart : milestoneLines.length;
      description = milestoneLines
        .slice(0, descEnd)
        .join("\n")
        .trim()
        .replace(/^\s*[\r\n]/gm, "")
        .replace(/[\r\n]\s*$/gm, "");
    }

    if (!description) {
      errors.push({
        field: `${fieldPrefix}.description`,
        message: "Milestone description is empty. Add one or more sentences describing what this milestone achieves.",
      });
      continue;
    }

    // Extract "Files to modify" list
    let filesToModify: string[] = [];
    if (filesStart >= 0) {
      let i = filesStart + 1;
      while (i < milestoneLines.length) {
        const line = milestoneLines[i];
        // Stop at the next section (h3, h4, or bold header)
        if (line.match(/^#+\s/) || line.match(/^\*\*\w+.*:\*\*/i)) {
          break;
        }
        // Extract list items (markdown or plain)
        const match = line.match(/^\s*[-*+]?\s*(.+)$/);
        if (match) {
          const file = match[1].trim();
          if (file && !file.match(/^\s*$/)) {
            filesToModify.push(file);
          }
        }
        i++;
      }
    }

    if (filesToModify.length === 0) {
      errors.push({
        field: `${fieldPrefix}.filesToModify`,
        message:
          "No files to modify listed. Add a '**Files to modify:**' section with one or more file paths (e.g., '- src/file.ts').",
      });
      continue;
    }

    // Extract "Acceptance criteria" list
    let acceptanceCriteria: string[] = [];
    if (criteriaStart >= 0) {
      let i = criteriaStart + 1;
      while (i < milestoneLines.length) {
        const line = milestoneLines[i];
        // Stop at the next section
        if (line.match(/^#+\s/) || (line.match(/^\*\*\w+.*:\*\*/i) && !line.match(/^Acceptance/i))) {
          break;
        }
        // Extract list items; strip leading [ ] checkbox markers
        const match = line.match(/^\s*[-*+]?\s*(?:\[\s*[xX]?\s*\])?\s*(.+)$/);
        if (match) {
          const criterion = match[1].trim();
          if (criterion && !criterion.match(/^\s*$/)) {
            acceptanceCriteria.push(criterion);
          }
        }
        i++;
      }
    }

    if (acceptanceCriteria.length === 0) {
      errors.push({
        field: `${fieldPrefix}.acceptanceCriteria`,
        message:
          "No acceptance criteria listed. Add an '**Acceptance criteria:**' section with one or more criteria (e.g., '- [ ] Tests pass').",
      });
      continue;
    }

    parsedMilestones.push({
      title,
      description,
      filesToModify,
      acceptanceCriteria,
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    blueprint: {
      approach,
      milestones: parsedMilestones,
    },
  };
}
