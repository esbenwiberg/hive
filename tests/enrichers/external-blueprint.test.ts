import { describe, it, expect } from "vitest";
import {
  parseMarkdownBlueprint,
  BLUEPRINT_MARKDOWN_TEMPLATE,
  type ParseResult,
} from "../../src/enrichers/external-blueprint.js";

describe("external-blueprint", () => {
  describe("parseMarkdownBlueprint", () => {
    it("should parse a valid blueprint with approach and milestones", () => {
      const markdown = `# Approach
This is the implementation strategy.

# Milestones

## Milestone 1: Setup
Set up the initial structure.

**Files to modify:**
- src/main.ts
- docs/README.md

**Acceptance criteria:**
- [ ] Files are created
- [ ] Tests pass

## Milestone 2: Implementation
Implement the core feature.

**Files to modify:**
- src/feature.ts

**Acceptance criteria:**
- [ ] Feature works
- [ ] Edge cases handled
`;

      const result = parseMarkdownBlueprint(markdown);
      expect(result.ok).toBe(true);
      expect(result.blueprint).toBeDefined();
      expect(result.blueprint!.approach).toContain("implementation strategy");
      expect(result.blueprint!.milestones).toHaveLength(2);
      expect(result.blueprint!.milestones![0].title).toBe("Milestone 1: Setup");
      expect(result.blueprint!.milestones![0].filesToModify).toContain("src/main.ts");
      expect(result.blueprint!.milestones![0].acceptanceCriteria).toContain("Files are created");
    });

    it("should return error when approach section is missing", () => {
      const markdown = `# Milestones

## Milestone 1: Test
Description.

**Files to modify:**
- src/file.ts

**Acceptance criteria:**
- [ ] Test criterion
`;

      const result = parseMarkdownBlueprint(markdown);
      expect(result.ok).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.some((e) => e.includes("Approach"))).toBe(true);
    });

    it("should return error when approach is empty", () => {
      const markdown = `# Approach

# Milestones

## Milestone 1: Test
Description.

**Files to modify:**
- src/file.ts

**Acceptance criteria:**
- [ ] Test criterion
`;

      const result = parseMarkdownBlueprint(markdown);
      expect(result.ok).toBe(false);
      expect(result.errors!.some((e) => e.includes("Approach"))).toBe(true);
    });

    it("should return error when milestones section is missing", () => {
      const markdown = `# Approach
Here is the approach.
`;

      const result = parseMarkdownBlueprint(markdown);
      expect(result.ok).toBe(false);
      expect(result.errors!.some((e) => e.includes("Milestones"))).toBe(true);
    });

    it("should return error when no milestones are defined", () => {
      const markdown = `# Approach
Here is the approach.

# Milestones
`;

      const result = parseMarkdownBlueprint(markdown);
      expect(result.ok).toBe(false);
      expect(result.errors!.some((e) => e.includes("No milestones"))).toBe(true);
    });

    it("should return error when milestone is missing title", () => {
      const markdown = `# Approach
Here is the approach.

# Milestones

##
Description of milestone.

**Files to modify:**
- src/file.ts

**Acceptance criteria:**
- [ ] Test criterion
`;

      const result = parseMarkdownBlueprint(markdown);
      expect(result.ok).toBe(false);
      expect(result.errors!.some((e) => e.includes("missing"))).toBe(true);
    });

    it("should return error when milestone is missing description", () => {
      const markdown = `# Approach
Here is the approach.

# Milestones

## Milestone 1: Test

**Files to modify:**
- src/file.ts

**Acceptance criteria:**
- [ ] Test criterion
`;

      const result = parseMarkdownBlueprint(markdown);
      expect(result.ok).toBe(false);
      expect(result.errors!.some((e) => e.includes("description"))).toBe(true);
    });

    it("should return error when milestone is missing filesToModify", () => {
      const markdown = `# Approach
Here is the approach.

# Milestones

## Milestone 1: Test
This is a test milestone.

**Acceptance criteria:**
- [ ] Test criterion
`;

      const result = parseMarkdownBlueprint(markdown);
      expect(result.ok).toBe(false);
      expect(result.errors!.some((e) => e.includes("Files to modify"))).toBe(true);
    });

    it("should return error when milestone is missing acceptanceCriteria", () => {
      const markdown = `# Approach
Here is the approach.

# Milestones

## Milestone 1: Test
This is a test milestone.

**Files to modify:**
- src/file.ts
`;

      const result = parseMarkdownBlueprint(markdown);
      expect(result.ok).toBe(false);
      expect(result.errors!.some((e) => e.includes("Acceptance criteria"))).toBe(true);
    });

    it("should handle empty input gracefully", () => {
      const result = parseMarkdownBlueprint("");
      expect(result.ok).toBe(false);
      expect(result.errors).toBeDefined();
    });

    it("should handle null input gracefully", () => {
      const result = parseMarkdownBlueprint(null as unknown as string);
      expect(result.ok).toBe(false);
      expect(result.errors).toBeDefined();
    });

    it("should successfully parse the canonical template", () => {
      const result = parseMarkdownBlueprint(BLUEPRINT_MARKDOWN_TEMPLATE);
      expect(result.ok).toBe(true);
      expect(result.blueprint).toBeDefined();
      expect(result.blueprint!.approach).toBeTruthy();
      expect(result.blueprint!.milestones).toBeDefined();
      expect(result.blueprint!.milestones!.length).toBeGreaterThan(0);
    });

    it("should parse milestone file paths correctly from list format", () => {
      const markdown = `# Approach
Test approach.

# Milestones

## Milestone 1: Test
Description.

**Files to modify:**
- src/file1.ts
- src/subdir/file2.ts
- docs/README.md

**Acceptance criteria:**
- [ ] Criterion 1
`;

      const result = parseMarkdownBlueprint(markdown);
      expect(result.ok).toBe(true);
      expect(result.blueprint!.milestones![0].filesToModify).toEqual([
        "src/file1.ts",
        "src/subdir/file2.ts",
        "docs/README.md",
      ]);
    });

    it("should parse acceptance criteria correctly from checkbox format", () => {
      const markdown = `# Approach
Test approach.

# Milestones

## Milestone 1: Test
Description.

**Files to modify:**
- src/file.ts

**Acceptance criteria:**
- [ ] First criterion with details
- [ ] Second criterion is specific
- [ ] Third one has more text explaining what to test
`;

      const result = parseMarkdownBlueprint(markdown);
      expect(result.ok).toBe(true);
      expect(result.blueprint!.milestones![0].acceptanceCriteria).toEqual([
        "First criterion with details",
        "Second criterion is specific",
        "Third one has more text explaining what to test",
      ]);
    });

    it("should handle multiple milestones with varied content", () => {
      const markdown = `# Approach
Complex implementation with multiple phases.

# Milestones

## Phase 1: Foundation
Build the foundation layer.

**Files to modify:**
- src/core/base.ts
- src/core/types.ts

**Acceptance criteria:**
- [ ] Base classes defined
- [ ] Types are correct

## Phase 2: Features
Add primary features.

**Files to modify:**
- src/features/main.ts
- src/features/utils.ts
- tests/features.test.ts

**Acceptance criteria:**
- [ ] All features work
- [ ] Tests pass
- [ ] No regressions

## Phase 3: Polish
Final touches and documentation.

**Files to modify:**
- docs/API.md
- src/index.ts

**Acceptance criteria:**
- [ ] Documentation complete
- [ ] API exported correctly
`;

      const result = parseMarkdownBlueprint(markdown);
      expect(result.ok).toBe(true);
      expect(result.blueprint!.milestones).toHaveLength(3);
      expect(result.blueprint!.milestones![1].title).toBe("Phase 2: Features");
      expect(result.blueprint!.milestones![1].filesToModify).toHaveLength(3);
      expect(result.blueprint!.milestones![2].acceptanceCriteria).toHaveLength(2);
    });
  });
});
