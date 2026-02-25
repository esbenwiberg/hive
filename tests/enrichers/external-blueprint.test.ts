import { describe, it, expect } from "vitest";
import {
  parseMarkdownBlueprint,
  BLUEPRINT_MARKDOWN_TEMPLATE,
} from "../../src/enrichers/external-blueprint.js";

describe("external-blueprint", () => {
  describe("parseMarkdownBlueprint", () => {
    it("should parse a valid full blueprint", () => {
      const markdown = `# Approach

Add support for creating tasks from external blueprints.

## Milestones

### Milestone 1: Parser

**Description:**
Implement a Markdown parser for blueprints.

**Files to Modify:**
- src/enrichers/external-blueprint.ts

**Acceptance Criteria:**
- Parser handles valid blueprints
- Parser rejects malformed input

### Milestone 2: Integration

**Description:**
Integrate parser into the pipeline.

**Files to Modify:**
- src/enrichers/index.ts
- src/dashboard/routes/tasks.ts

**Acceptance Criteria:**
- Tasks can be created with blueprints
- Validation errors are shown to users
`;

      const result = parseMarkdownBlueprint(markdown);
      expect(result.ok).toBe(true);
      expect(result.blueprint).toBeDefined();
      expect(result.blueprint!.approach).toContain(
        "Add support for creating tasks from external blueprints",
      );
      expect(result.blueprint!.milestones).toHaveLength(2);

      const m1 = result.blueprint!.milestones[0];
      expect(m1.title).toBe("Parser");
      expect(m1.description).toContain("Implement a Markdown parser");
      expect(m1.filesToModify).toContain("src/enrichers/external-blueprint.ts");
      expect(m1.acceptanceCriteria).toHaveLength(2);

      const m2 = result.blueprint!.milestones[1];
      expect(m2.title).toBe("Integration");
      expect(m2.filesToModify).toContain("src/enrichers/index.ts");
      expect(m2.filesToModify).toContain("src/dashboard/routes/tasks.ts");
    });

    it("should reject blueprint missing # Approach section", () => {
      const markdown = `## Milestones

### Milestone 1: Test

**Description:**
Test description.

**Files to Modify:**
- src/test.ts

**Acceptance Criteria:**
- Test passes
`;

      const result = parseMarkdownBlueprint(markdown);
      expect(result.ok).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.some((e) => e.includes("# Approach"))).toBe(true);
    });

    it("should reject blueprint with empty approach section", () => {
      const markdown = `# Approach

## Milestones

### Milestone 1: Test

**Description:**
Test description.

**Files to Modify:**
- src/test.ts

**Acceptance Criteria:**
- Test passes
`;

      const result = parseMarkdownBlueprint(markdown);
      expect(result.ok).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.some((e) => e.includes("empty"))).toBe(true);
    });

    it("should reject blueprint missing ## Milestones section", () => {
      const markdown = `# Approach

This is the approach text.
`;

      const result = parseMarkdownBlueprint(markdown);
      expect(result.ok).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.some((e) => e.includes("Milestones"))).toBe(true);
    });

    it("should reject blueprint with no milestones", () => {
      const markdown = `# Approach

This is the approach text.

## Milestones
`;

      const result = parseMarkdownBlueprint(markdown);
      expect(result.ok).toBe(false);
      expect(result.errors).toBeDefined();
      expect(
        result.errors!.some((e) => e.includes("No milestones found")),
      ).toBe(true);
    });

    it("should reject milestone with missing title", () => {
      const markdown = `# Approach

Test approach.

## Milestones

### Milestone Test

**Description:**
Description.

**Files to Modify:**
- src/test.ts

**Acceptance Criteria:**
- Criterion
`;

      const result = parseMarkdownBlueprint(markdown);
      expect(result.ok).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.some((e) => e.includes("Invalid title format"))).toBe(
        true,
      );
    });

    it("should reject milestone with missing Description section", () => {
      const markdown = `# Approach

Test approach.

## Milestones

### Milestone 1: Test

**Files to Modify:**
- src/test.ts

**Acceptance Criteria:**
- Criterion
`;

      const result = parseMarkdownBlueprint(markdown);
      expect(result.ok).toBe(false);
      expect(result.errors).toBeDefined();
      expect(
        result.errors!.some((e) => e.includes("Description"))
      ).toBe(true);
    });

    it("should reject milestone with empty description", () => {
      const markdown = `# Approach

Test approach.

## Milestones

### Milestone 1: Test

**Description:**

**Files to Modify:**
- src/test.ts

**Acceptance Criteria:**
- Criterion
`;

      const result = parseMarkdownBlueprint(markdown);
      expect(result.ok).toBe(false);
      expect(result.errors).toBeDefined();
      expect(
        result.errors!.some((e) => e.includes("Description cannot be empty"))
      ).toBe(true);
    });

    it("should reject milestone with missing Files to Modify section", () => {
      const markdown = `# Approach

Test approach.

## Milestones

### Milestone 1: Test

**Description:**
Test description.

**Acceptance Criteria:**
- Criterion
`;

      const result = parseMarkdownBlueprint(markdown);
      expect(result.ok).toBe(false);
      expect(result.errors).toBeDefined();
      expect(
        result.errors!.some((e) => e.includes("Files to Modify"))
      ).toBe(true);
    });

    it("should reject milestone with empty Files to Modify list", () => {
      const markdown = `# Approach

Test approach.

## Milestones

### Milestone 1: Test

**Description:**
Test description.

**Files to Modify:**

**Acceptance Criteria:**
- Criterion
`;

      const result = parseMarkdownBlueprint(markdown);
      expect(result.ok).toBe(false);
      expect(result.errors).toBeDefined();
      expect(
        result.errors!.some((e) => e.includes("Files to Modify"))
      ).toBe(true);
    });

    it("should reject milestone with missing Acceptance Criteria section", () => {
      const markdown = `# Approach

Test approach.

## Milestones

### Milestone 1: Test

**Description:**
Test description.

**Files to Modify:**
- src/test.ts
`;

      const result = parseMarkdownBlueprint(markdown);
      expect(result.ok).toBe(false);
      expect(result.errors).toBeDefined();
      expect(
        result.errors!.some((e) => e.includes("Acceptance Criteria"))
      ).toBe(true);
    });

    it("should reject milestone with empty Acceptance Criteria list", () => {
      const markdown = `# Approach

Test approach.

## Milestones

### Milestone 1: Test

**Description:**
Test description.

**Files to Modify:**
- src/test.ts

**Acceptance Criteria:**
`;

      const result = parseMarkdownBlueprint(markdown);
      expect(result.ok).toBe(false);
      expect(result.errors).toBeDefined();
      expect(
        result.errors!.some((e) => e.includes("Acceptance Criteria"))
      ).toBe(true);
    });

    it("should parse the canonical template successfully", () => {
      const result = parseMarkdownBlueprint(BLUEPRINT_MARKDOWN_TEMPLATE);
      expect(result.ok).toBe(true);
      expect(result.blueprint).toBeDefined();
      expect(result.blueprint!.approach).toBeDefined();
      expect(result.blueprint!.milestones.length).toBeGreaterThan(0);
    });

    it("should handle milestones with multiline descriptions", () => {
      const markdown = `# Approach

Test approach.

## Milestones

### Milestone 1: Test

**Description:**
This is a multiline
description that spans
multiple lines.

**Files to Modify:**
- src/test.ts

**Acceptance Criteria:**
- Criterion
`;

      const result = parseMarkdownBlueprint(markdown);
      expect(result.ok).toBe(true);
      expect(result.blueprint!.milestones[0].description).toContain(
        "multiline",
      );
    });

    it("should handle milestones with multiple files and criteria", () => {
      const markdown = `# Approach

Test approach.

## Milestones

### Milestone 1: Test

**Description:**
Test description.

**Files to Modify:**
- src/file1.ts
- src/file2.ts
- src/dir/file3.ts

**Acceptance Criteria:**
- First criterion
- Second criterion
- Third criterion with more details
`;

      const result = parseMarkdownBlueprint(markdown);
      expect(result.ok).toBe(true);
      expect(result.blueprint!.milestones[0].filesToModify).toHaveLength(3);
      expect(result.blueprint!.milestones[0].acceptanceCriteria).toHaveLength(3);
    });
  });
});
