import { describe, it, expect } from "vitest";
import {
  parseMarkdownBlueprint,
  BLUEPRINT_MARKDOWN_TEMPLATE,
} from "../../src/enrichers/external-blueprint.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const VALID_MARKDOWN = `# Approach

This is the overall implementation strategy. We will do things step by step.

# Milestones

### 1. Set up the module

Create the initial module structure and export the public API.

**Files to modify**
- src/example/module.ts
- src/example/index.ts

**Acceptance criteria**
- The module exports a \`setup()\` function
- Unit tests pass
`;

// ── Tests ────────────────────────────────────────────────────────────────────

describe("parseMarkdownBlueprint", () => {
  // ── Valid full blueprint ───────────────────────────────────────────────────

  describe("valid full blueprint", () => {
    it("returns ok: true with a properly shaped blueprint", () => {
      const result = parseMarkdownBlueprint(VALID_MARKDOWN);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Expected ok");

      expect(result.blueprint.approach).toContain("implementation strategy");
      expect(result.blueprint.milestones).toHaveLength(1);
    });

    it("parses milestone title correctly", () => {
      const result = parseMarkdownBlueprint(VALID_MARKDOWN);
      if (!result.ok) throw new Error("Expected ok");

      expect(result.blueprint.milestones[0].title).toBe("1. Set up the module");
    });

    it("parses milestone description correctly", () => {
      const result = parseMarkdownBlueprint(VALID_MARKDOWN);
      if (!result.ok) throw new Error("Expected ok");

      expect(result.blueprint.milestones[0].description).toContain("initial module structure");
    });

    it("parses filesToModify correctly", () => {
      const result = parseMarkdownBlueprint(VALID_MARKDOWN);
      if (!result.ok) throw new Error("Expected ok");

      expect(result.blueprint.milestones[0].filesToModify).toEqual([
        "src/example/module.ts",
        "src/example/index.ts",
      ]);
    });

    it("parses acceptanceCriteria correctly", () => {
      const result = parseMarkdownBlueprint(VALID_MARKDOWN);
      if (!result.ok) throw new Error("Expected ok");

      expect(result.blueprint.milestones[0].acceptanceCriteria).toEqual([
        "The module exports a `setup()` function",
        "Unit tests pass",
      ]);
    });

    it("handles multiple milestones", () => {
      const md = `# Approach

Strategy here.

# Milestones

### Milestone A

Description A.

**Files to modify**
- src/a.ts

**Acceptance criteria**
- Criterion A

### Milestone B

Description B.

**Files to modify**
- src/b.ts

**Acceptance criteria**
- Criterion B
`;
      const result = parseMarkdownBlueprint(md);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Expected ok");

      expect(result.blueprint.milestones).toHaveLength(2);
      expect(result.blueprint.milestones[0].title).toBe("Milestone A");
      expect(result.blueprint.milestones[1].title).toBe("Milestone B");
    });
  });

  // ── Missing approach ──────────────────────────────────────────────────────

  describe("missing approach section", () => {
    it("returns ok: false when # Approach is absent", () => {
      const md = `# Milestones

### Do something

Description here.

**Files to modify**
- src/foo.ts

**Acceptance criteria**
- It works
`;
      const result = parseMarkdownBlueprint(md);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected failure");

      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("error message mentions 'Approach'", () => {
      const md = `# Milestones

### Do something

Description here.

**Files to modify**
- src/foo.ts

**Acceptance criteria**
- It works
`;
      const result = parseMarkdownBlueprint(md);
      if (result.ok) throw new Error("Expected failure");

      const combined = result.errors.join(" ");
      expect(combined.toLowerCase()).toContain("approach");
    });

    it("returns ok: false when # Approach heading exists but body is empty", () => {
      const md = `# Approach

# Milestones

### Do something

Description.

**Files to modify**
- src/foo.ts

**Acceptance criteria**
- Criterion
`;
      const result = parseMarkdownBlueprint(md);
      expect(result.ok).toBe(false);
    });
  });

  // ── Empty milestones array ────────────────────────────────────────────────

  describe("empty milestones array", () => {
    it("returns ok: false when milestones section has no ### sub-headings", () => {
      const md = `# Approach

Good strategy.

# Milestones

There are no milestones listed here.
`;
      const result = parseMarkdownBlueprint(md);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected failure");

      expect(result.errors.length).toBeGreaterThan(0);
    });

    it("error message mentions milestones", () => {
      const md = `# Approach

Good strategy.

# Milestones
`;
      const result = parseMarkdownBlueprint(md);
      if (result.ok) throw new Error("Expected failure");

      const combined = result.errors.join(" ").toLowerCase();
      expect(combined).toContain("milestone");
    });

    it("returns ok: false when milestones section is completely missing", () => {
      const md = `# Approach

Strategy here.
`;
      const result = parseMarkdownBlueprint(md);
      expect(result.ok).toBe(false);
    });
  });

  // ── Missing milestone fields ──────────────────────────────────────────────

  describe("missing milestone fields", () => {
    it("returns ok: false when filesToModify is missing", () => {
      const md = `# Approach

Strategy.

# Milestones

### Do something

Description here.

**Acceptance criteria**
- It works
`;
      const result = parseMarkdownBlueprint(md);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected failure");

      const combined = result.errors.join(" ").toLowerCase();
      expect(combined).toContain("files");
    });

    it("returns ok: false when acceptanceCriteria is missing", () => {
      const md = `# Approach

Strategy.

# Milestones

### Do something

Description here.

**Files to modify**
- src/foo.ts
`;
      const result = parseMarkdownBlueprint(md);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected failure");

      const combined = result.errors.join(" ").toLowerCase();
      expect(combined).toContain("acceptance");
    });

    it("returns ok: false when milestone description is missing", () => {
      const md = `# Approach

Strategy.

# Milestones

### Do something

**Files to modify**
- src/foo.ts

**Acceptance criteria**
- Criterion
`;
      const result = parseMarkdownBlueprint(md);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected failure");

      const combined = result.errors.join(" ").toLowerCase();
      expect(combined).toContain("description");
    });

    it("reports errors for all incomplete milestones", () => {
      const md = `# Approach

Strategy.

# Milestones

### Milestone with no fields
`;
      const result = parseMarkdownBlueprint(md);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected failure");

      // Should report missing description, files, and criteria
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
    });

    it("reports the milestone title in the error message", () => {
      const md = `# Approach

Strategy.

# Milestones

### My Special Milestone

**Files to modify**
- src/foo.ts
`;
      const result = parseMarkdownBlueprint(md);
      if (result.ok) throw new Error("Expected failure");

      const combined = result.errors.join(" ");
      expect(combined).toContain("My Special Milestone");
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("returns ok: false for empty string input", () => {
      const result = parseMarkdownBlueprint("");
      expect(result.ok).toBe(false);
    });

    it("returns ok: false for whitespace-only input", () => {
      const result = parseMarkdownBlueprint("   \n  \n  ");
      expect(result.ok).toBe(false);
    });
  });

  // ── BLUEPRINT_MARKDOWN_TEMPLATE ───────────────────────────────────────────

  describe("BLUEPRINT_MARKDOWN_TEMPLATE", () => {
    it("is a non-empty string", () => {
      expect(typeof BLUEPRINT_MARKDOWN_TEMPLATE).toBe("string");
      expect(BLUEPRINT_MARKDOWN_TEMPLATE.length).toBeGreaterThan(0);
    });

    it("parses successfully through the parser", () => {
      const result = parseMarkdownBlueprint(BLUEPRINT_MARKDOWN_TEMPLATE);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(`Template failed to parse: ${result.errors.join("; ")}`);
      }
    });

    it("template blueprint has a non-empty approach", () => {
      const result = parseMarkdownBlueprint(BLUEPRINT_MARKDOWN_TEMPLATE);
      if (!result.ok) throw new Error("Expected ok");

      expect(result.blueprint.approach.length).toBeGreaterThan(0);
    });

    it("template blueprint has at least one milestone", () => {
      const result = parseMarkdownBlueprint(BLUEPRINT_MARKDOWN_TEMPLATE);
      if (!result.ok) throw new Error("Expected ok");

      expect(result.blueprint.milestones.length).toBeGreaterThan(0);
    });
  });
});
