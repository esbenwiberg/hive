import { describe, it, expect } from "vitest";
import {
  parseBlueprint,
  inferSizeFromMilestones,
} from "../../src/blueprints/parser.js";

describe("Blueprint Parser", () => {
  describe("parseBlueprint", () => {
    it("parses a valid full blueprint", () => {
      const markdown = `# Approach

This is my high-level strategy to solve the problem.

# Milestone 1: Add database schema

## Description
Create the database tables needed for this feature.

## Files to Modify
- src/db/schema.ts
- drizzle/0001_initial.sql

## Acceptance Criteria
- Schema includes all required columns
- Migration runs without error
- Tests pass`;

      const result = parseBlueprint(markdown);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.blueprint.approach).toContain("high-level strategy");
        expect(result.blueprint.milestones).toHaveLength(1);
        expect(result.blueprint.milestones[0].title).toBe("Add database schema");
        expect(result.blueprint.milestones[0].filesToModify).toContain(
          "src/db/schema.ts",
        );
        expect(result.blueprint.milestones[0].acceptanceCriteria.length).toBe(3);
      }
    });

    it("parses multiple milestones", () => {
      const markdown = `# Approach
High-level strategy.

# Milestone 1: First milestone
## Description
First thing.
## Files to Modify
- file1.ts
## Acceptance Criteria
- Works

# Milestone 2: Second milestone
## Description
Second thing.
## Files to Modify
- file2.ts
## Acceptance Criteria
- Also works`;

      const result = parseBlueprint(markdown);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.blueprint.milestones).toHaveLength(2);
        expect(result.blueprint.milestones[0].title).toBe("First milestone");
        expect(result.blueprint.milestones[1].title).toBe("Second milestone");
      }
    });

    it("returns error when approach is missing", () => {
      const markdown = `# Milestone 1: Something
## Description
Do something.
## Files to Modify
- file.ts
## Acceptance Criteria
- Works`;

      const result = parseBlueprint(markdown);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toContainEqual(
          expect.objectContaining({
            field: "approach",
            message: expect.stringContaining("Missing"),
          }),
        );
      }
    });

    it("returns error when no milestones are present", () => {
      const markdown = `# Approach
This is the approach.`;

      const result = parseBlueprint(markdown);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toContainEqual(
          expect.objectContaining({
            field: "milestones",
            message: expect.stringContaining("No milestones found"),
          }),
        );
      }
    });

    it("returns error when milestone is missing description", () => {
      const markdown = `# Approach
High-level strategy.

# Milestone 1: Title only
## Files to Modify
- file.ts
## Acceptance Criteria
- Works`;

      const result = parseBlueprint(markdown);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toContainEqual(
          expect.objectContaining({
            field: expect.stringContaining("description"),
            message: expect.stringContaining("missing"),
          }),
        );
      }
    });

    it("returns error when milestone is missing files to modify", () => {
      const markdown = `# Approach
High-level strategy.

# Milestone 1: Something
## Description
Do something.
## Acceptance Criteria
- Works`;

      const result = parseBlueprint(markdown);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toContainEqual(
          expect.objectContaining({
            field: expect.stringContaining("filesToModify"),
            message: expect.stringContaining("should list files"),
          }),
        );
      }
    });

    it("returns error when milestone is missing acceptance criteria", () => {
      const markdown = `# Approach
High-level strategy.

# Milestone 1: Something
## Description
Do something.
## Files to Modify
- file.ts`;

      const result = parseBlueprint(markdown);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toContainEqual(
          expect.objectContaining({
            field: expect.stringContaining("acceptanceCriteria"),
            message: expect.stringContaining("should list"),
          }),
        );
      }
    });

    it("handles multiple validation errors", () => {
      const markdown = `# Milestone 1: Missing everything
## Description
Something.`;

      const result = parseBlueprint(markdown);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.length).toBeGreaterThanOrEqual(2);
      }
    });

    it("handles markdown bullet points with dashes and asterisks", () => {
      const markdown = `# Approach
Strategy.

# Milestone 1: Test bullets
## Description
Testing bullet parsing.
## Files to Modify
- file1.ts
* file2.ts
- file3.ts
## Acceptance Criteria
- Criterion 1
* Criterion 2`;

      const result = parseBlueprint(markdown);

      expect(result.ok).toBe(true);
      if (result.ok) {
        const files = result.blueprint.milestones[0].filesToModify;
        expect(files).toContain("file1.ts");
        expect(files).toContain("file2.ts");
        expect(files).toContain("file3.ts");

        const criteria = result.blueprint.milestones[0].acceptanceCriteria;
        expect(criteria).toContain("Criterion 1");
        expect(criteria).toContain("Criterion 2");
      }
    });

    it("preserves multi-line descriptions", () => {
      const markdown = `# Approach
This is a multi-line approach.
It spans multiple lines.
And has several paragraphs.

# Milestone 1: Something
## Description
This is a multi-line description.
It explains what happens in this milestone.
It can be quite detailed.
## Files to Modify
- file.ts
## Acceptance Criteria
- Works`;

      const result = parseBlueprint(markdown);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.blueprint.approach).toContain("multi-line approach");
        expect(result.blueprint.approach).toContain("several paragraphs");
        expect(result.blueprint.milestones[0].description).toContain(
          "multi-line description",
        );
        expect(result.blueprint.milestones[0].description).toContain(
          "It explains",
        );
      }
    });
  });

  describe("inferSizeFromMilestones", () => {
    it("returns 'small' for 0-1 milestones", () => {
      expect(inferSizeFromMilestones(0)).toBe("small");
      expect(inferSizeFromMilestones(1)).toBe("small");
    });

    it("returns 'medium' for 2 milestones", () => {
      expect(inferSizeFromMilestones(2)).toBe("medium");
    });

    it("returns 'large' for 3+ milestones", () => {
      expect(inferSizeFromMilestones(3)).toBe("large");
      expect(inferSizeFromMilestones(4)).toBe("large");
      expect(inferSizeFromMilestones(10)).toBe("large");
    });
  });
});
