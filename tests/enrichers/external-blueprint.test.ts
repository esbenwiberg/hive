import { describe, it, expect } from "vitest";
import { parseMarkdownBlueprint, BLUEPRINT_MARKDOWN_TEMPLATE } from "../../src/enrichers/external-blueprint.js";

describe("external-blueprint parser", () => {
  describe("parseMarkdownBlueprint — happy path", () => {
    it("parses a valid full blueprint with approach and milestones", () => {
      const markdown = `# Approach

This is the implementation strategy.

## Milestones

### Milestone One

Implement the first part.

**Files to modify**
- src/module.ts
- src/index.ts

**Acceptance criteria**
- The function works
- Tests pass
`;

      const result = parseMarkdownBlueprint(markdown);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.blueprint.approach).toContain("implementation strategy");
        expect(result.blueprint.milestones).toHaveLength(1);
        expect(result.blueprint.milestones[0].title).toBe("Milestone One");
        expect(result.blueprint.milestones[0].filesToModify).toContain("src/module.ts");
        expect(result.blueprint.milestones[0].acceptanceCriteria).toContain("The function works");
      }
    });

    it("parses multiple milestones", () => {
      const markdown = `# Approach

Multi-milestone approach.

## Milestones

### First Milestone

First description.

**Files to modify**
- file1.ts

**Acceptance criteria**
- Criterion 1

### Second Milestone

Second description.

**Files to modify**
- file2.ts

**Acceptance criteria**
- Criterion 2
`;

      const result = parseMarkdownBlueprint(markdown);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.blueprint.milestones).toHaveLength(2);
        expect(result.blueprint.milestones[0].title).toBe("First Milestone");
        expect(result.blueprint.milestones[1].title).toBe("Second Milestone");
      }
    });
  });

  describe("parseMarkdownBlueprint — error cases", () => {
    it("returns error when approach section is missing", () => {
      const markdown = `## Milestones

### Milestone One

Description.

**Files to modify**
- file.ts

**Acceptance criteria**
- Criterion
`;

      const result = parseMarkdownBlueprint(markdown);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.toLowerCase().includes("approach"))).toBe(true);
      }
    });

    it("returns error when approach is empty", () => {
      const markdown = `# Approach

## Milestones

### Milestone One

Description.

**Files to modify**
- file.ts

**Acceptance criteria**
- Criterion
`;

      const result = parseMarkdownBlueprint(markdown);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.toLowerCase().includes("approach"))).toBe(true);
      }
    });

    it("returns error when milestones section is missing", () => {
      const markdown = `# Approach

Implementation strategy here.
`;

      const result = parseMarkdownBlueprint(markdown);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.toLowerCase().includes("milestones"))).toBe(true);
      }
    });

    it("returns error when milestones array is empty", () => {
      const markdown = `# Approach

Implementation strategy here.

## Milestones
`;

      const result = parseMarkdownBlueprint(markdown);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.toLowerCase().includes("contains no milestones"))).toBe(true);
      }
    });

    it("returns error when milestone is missing files to modify", () => {
      const markdown = `# Approach

Strategy.

## Milestones

### Milestone One

Description.

**Acceptance criteria**
- Criterion
`;

      const result = parseMarkdownBlueprint(markdown);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.toLowerCase().includes("files to modify"))).toBe(true);
      }
    });

    it("returns error when milestone is missing acceptance criteria", () => {
      const markdown = `# Approach

Strategy.

## Milestones

### Milestone One

Description.

**Files to modify**
- file.ts
`;

      const result = parseMarkdownBlueprint(markdown);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.toLowerCase().includes("acceptance criteria"))).toBe(true);
      }
    });

    it("returns error when blueprint is empty", () => {
      const result = parseMarkdownBlueprint("");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.toLowerCase().includes("empty"))).toBe(true);
      }
    });
  });

  describe("BLUEPRINT_MARKDOWN_TEMPLATE", () => {
    it("is itself a valid blueprint", () => {
      const result = parseMarkdownBlueprint(BLUEPRINT_MARKDOWN_TEMPLATE);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.blueprint.approach).toBeTruthy();
        expect(result.blueprint.milestones.length).toBeGreaterThan(0);
      }
    });
  });
});
