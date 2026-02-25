import { describe, it, expect } from "vitest";
import {
  parseMarkdownBlueprint,
  BLUEPRINT_MARKDOWN_TEMPLATE,
  type ParseResult,
} from "../../src/enrichers/external-blueprint.js";

describe("External Blueprint Parser", () => {
  describe("parseMarkdownBlueprint", () => {
    it("parses a valid full blueprint with multiple milestones", () => {
      const markdown = `## Approach

This is the high-level strategy for implementing the feature.

## Milestones

### Milestone 1: Set up database

**Description:**
Create the database schema and migrations.

**Files to Modify:**
- src/db/schema.ts
- drizzle/0001_initial.sql

**Acceptance Criteria:**
- Database migration runs successfully
- Schema is created with all required columns

### Milestone 2: Implement API

**Description:**
Build the API endpoints for the feature.

**Files to Modify:**
- src/api/routes.ts
- src/api/handlers.ts

**Acceptance Criteria:**
- All endpoints are implemented
- Unit tests pass
`;

      const result = parseMarkdownBlueprint(markdown);
      expect(result.ok).toBe(true);
      expect(result.blueprint).toBeDefined();
      expect(result.blueprint?.approach).toContain("high-level strategy");
      expect(result.blueprint?.milestones).toHaveLength(2);
      expect(result.blueprint?.milestones?.[0].title).toBe("Set up database");
      expect(result.blueprint?.milestones?.[0].filesToModify).toContain("src/db/schema.ts");
      expect(result.blueprint?.milestones?.[1].title).toBe("Implement API");
    });

    it("returns error when 'Approach' section is missing", () => {
      const markdown = `## Milestones

### Milestone 1: Work

**Description:**
Some work.

**Files to Modify:**
- src/file.ts

**Acceptance Criteria:**
- Criterion 1
`;

      const result = parseMarkdownBlueprint(markdown);
      expect(result.ok).toBe(false);
      expect(result.errors).toContain("Missing required section: '## Approach'");
    });

    it("returns error when 'Approach' section is empty", () => {
      const markdown = `## Approach

## Milestones

### Milestone 1: Work

**Description:**
Some work.

**Files to Modify:**
- src/file.ts

**Acceptance Criteria:**
- Criterion 1
`;

      const result = parseMarkdownBlueprint(markdown);
      expect(result.ok).toBe(false);
      expect(result.errors).toContain("'Approach' section is empty");
    });

    it("returns error when 'Milestones' section is missing", () => {
      const markdown = `## Approach

This is the approach.
`;

      const result = parseMarkdownBlueprint(markdown);
      expect(result.ok).toBe(false);
      expect(result.errors).toContain("Missing required section: '## Milestones'");
    });

    it("returns error when no milestones are defined", () => {
      const markdown = `## Approach

This is the approach.

## Milestones
`;

      const result = parseMarkdownBlueprint(markdown);
      expect(result.ok).toBe(false);
      expect(result.errors).toContain("'Milestones' section must contain at least one milestone");
    });

    it("returns error when milestone has empty acceptance criteria", () => {
      const markdown = `## Approach

This is the approach.

## Milestones

### Milestone 1: Work

**Description:**
Some work.

**Files to Modify:**
- src/file.ts

**Acceptance Criteria:**
`;

      const result = parseMarkdownBlueprint(markdown);
      expect(result.ok).toBe(false);
      expect(result.errors?.length).toBeGreaterThan(0);
    });

    it("parses milestone with multiple files and criteria correctly", () => {
      const markdown = `## Approach

Implementation strategy.

## Milestones

### Milestone 1: Task

**Description:**
Detailed description of the task.

**Files to Modify:**
- src/file1.ts
- src/file2.ts
- tests/file1.test.ts

**Acceptance Criteria:**
- First criterion is met
- Second criterion passes
- Third criterion verified
`;

      const result = parseMarkdownBlueprint(markdown);
      expect(result.ok).toBe(true);
      expect(result.blueprint?.milestones?.[0].filesToModify).toHaveLength(3);
      expect(result.blueprint?.milestones?.[0].filesToModify).toContain("src/file1.ts");
      expect(result.blueprint?.milestones?.[0].acceptanceCriteria).toHaveLength(3);
      expect(result.blueprint?.milestones?.[0].acceptanceCriteria[0]).toBe("First criterion is met");
    });

    it("handles markdown with extra whitespace correctly", () => {
      const markdown = `## Approach

   Some approach with leading spaces.

## Milestones

### Milestone 1:   Work with spaces

**Description:**
   Description with spaces.

**Files to Modify:**
-    src/file.ts

**Acceptance Criteria:**
-    Criterion with spaces
`;

      const result = parseMarkdownBlueprint(markdown);
      expect(result.ok).toBe(true);
      expect(result.blueprint?.milestones?.[0].title).toBe("Work with spaces");
      expect(result.blueprint?.milestones?.[0].filesToModify).toContain("src/file.ts");
    });

    it("parses the template constant successfully", () => {
      const result = parseMarkdownBlueprint(BLUEPRINT_MARKDOWN_TEMPLATE);
      expect(result.ok).toBe(true);
      expect(result.blueprint).toBeDefined();
      expect(result.blueprint?.approach).toBeDefined();
      expect(result.blueprint?.milestones?.length).toBeGreaterThan(0);
    });

    it("handles input with no milestones gracefully", () => {
      const markdown = `## Approach

This is the approach.

## Other Section

This is ignored.
`;

      const result = parseMarkdownBlueprint(markdown);
      expect(result.ok).toBe(false);
      expect(result.errors).toContain("Missing required section: '## Milestones'");
    });

    it("rejects non-string input", () => {
      const result = parseMarkdownBlueprint(null as unknown as string);
      expect(result.ok).toBe(false);
      expect(result.errors?.length).toBeGreaterThan(0);
    });

    it("rejects empty string input", () => {
      const result = parseMarkdownBlueprint("");
      expect(result.ok).toBe(false);
      expect(result.errors?.length).toBeGreaterThan(0);
    });
  });
});
