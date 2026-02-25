import { describe, it, expect } from "vitest";
import { parseBlueprint } from "../../src/blueprints/parser.js";
import type { Blueprint, BlueprintValidationError } from "../../src/blueprints/schema.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildValidBlueprint(overrides: {
  approach?: string;
  milestones?: string;
} = {}): string {
  const approach =
    overrides.approach ??
    `We will implement this feature in three milestones, each building on the last.
The approach uses a layered architecture so the domain layer stays independent.`;

  const milestones =
    overrides.milestones ??
    `## Milestone 1: Define the schema

Add TypeScript types for the new domain object and write a Zod validator.

### Files to Modify

- \`src/domain/types.ts\`
- \`src/domain/validators.ts\`

### Acceptance Criteria

- \`npm run typecheck\` passes with no new errors
- Zod schema rejects invalid payloads and returns descriptive messages

---

## Milestone 2: Implement the service

Wire the new types into the service layer and add unit tests.

### Files to Modify

- \`src/services/widget.ts\`

### Acceptance Criteria

- Service returns the correct result for happy-path inputs
- Unit tests cover the error branch`;

  return `# My Feature

## Approach

${approach}

---

${milestones}
`;
}

// ── Valid blueprint ───────────────────────────────────────────────────────────

describe("parseBlueprint — valid full blueprint", () => {
  it("returns ok:true with a correctly shaped Blueprint", () => {
    const result = parseBlueprint(buildValidBlueprint());

    expect(result.ok).toBe(true);
    if (!result.ok) return; // narrow

    const bp: Blueprint = result.blueprint;
    expect(bp.approach).toContain("layered architecture");
    expect(bp.milestones).toHaveLength(2);

    const [m1, m2] = bp.milestones;

    expect(m1.title).toBe("Define the schema");
    expect(m1.description).toContain("TypeScript types");
    expect(m1.filesToModify).toEqual([
      "src/domain/types.ts",
      "src/domain/validators.ts",
    ]);
    expect(m1.acceptanceCriteria).toHaveLength(2);
    expect(m1.acceptanceCriteria[0]).toContain("npm run typecheck");

    expect(m2.title).toBe("Implement the service");
    expect(m2.filesToModify).toEqual(["src/services/widget.ts"]);
    expect(m2.acceptanceCriteria).toHaveLength(2);
  });

  it("accepts milestone titles with various separator styles", () => {
    const md = `## Approach

Short approach.

## Milestone 1 — First thing

Description of first thing.

### Acceptance Criteria

- Criterion one
`;
    const result = parseBlueprint(md);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.blueprint.milestones[0].title).toBe("First thing");
  });

  it("treats a milestone with no filesToModify section as having an empty array", () => {
    const md = `## Approach

Short approach text.

## Milestone 1: Schema only

Description here.

### Acceptance Criteria

- Thing works
`;
    const result = parseBlueprint(md);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.blueprint.milestones[0].filesToModify).toEqual([]);
  });
});

// ── Missing approach ──────────────────────────────────────────────────────────

describe("parseBlueprint — missing approach", () => {
  it("returns ok:false with an error pointing at the approach field", () => {
    const md = `# My Feature

## Milestone 1: Do the thing

Description of the thing.

### Acceptance Criteria

- It works
`;
    const result = parseBlueprint(md);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    const errors: BlueprintValidationError[] = result.errors;
    expect(errors.some((e) => e.field === "approach")).toBe(true);
    expect(errors.find((e) => e.field === "approach")?.message).toMatch(/approach/i);
  });

  it("returns ok:false when approach section is present but empty", () => {
    const md = `## Approach

## Milestone 1: Do the thing

Description.

### Acceptance Criteria

- Works
`;
    const result = parseBlueprint(md);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.field === "approach")).toBe(true);
  });
});

// ── No milestones ─────────────────────────────────────────────────────────────

describe("parseBlueprint — no milestones", () => {
  it("returns ok:false when there are no milestone sections", () => {
    const md = `## Approach

Here is my approach.

## Background

Some extra context that is not a milestone.
`;
    const result = parseBlueprint(md);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.errors.some((e) => e.field === "milestones")).toBe(true);
  });
});

// ── Milestone missing title ───────────────────────────────────────────────────

describe("parseBlueprint — milestone missing title", () => {
  it("returns ok:false with a field path for the title", () => {
    // "## Milestone 1" with just a number — no title text
    const md = `## Approach

My approach text.

## Milestone 1

Description of the work.

### Acceptance Criteria

- It works
`;
    const result = parseBlueprint(md);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    const titleError = result.errors.find((e) => e.field === "milestones[0].title");
    expect(titleError).toBeDefined();
    expect(titleError?.message).toMatch(/title/i);
  });
});

// ── Milestone missing acceptanceCriteria ──────────────────────────────────────

describe("parseBlueprint — milestone missing acceptanceCriteria", () => {
  it("returns ok:false when the Acceptance Criteria section is absent", () => {
    const md = `## Approach

My approach text.

## Milestone 1: Do the thing

Description of the work.

### Files to Modify

- \`src/foo.ts\`
`;
    const result = parseBlueprint(md);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    const acError = result.errors.find((e) =>
      e.field === "milestones[0].acceptanceCriteria",
    );
    expect(acError).toBeDefined();
    expect(acError?.message).toMatch(/acceptance criteria/i);
  });

  it("returns ok:false when Acceptance Criteria section exists but has no list items", () => {
    const md = `## Approach

My approach text.

## Milestone 1: Do the thing

Description of the work.

### Acceptance Criteria

No bullets here, just prose.
`;
    const result = parseBlueprint(md);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    const acError = result.errors.find((e) =>
      e.field === "milestones[0].acceptanceCriteria",
    );
    expect(acError).toBeDefined();
    expect(acError?.message).toMatch(/no list items|bullet/i);
  });
});

// ── BlueprintValidationError shape ────────────────────────────────────────────

describe("BlueprintValidationError shape", () => {
  it("every error has a non-empty field and message", () => {
    const md = `# No approach, no milestones`;
    const result = parseBlueprint(md);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    for (const err of result.errors) {
      expect(typeof err.field).toBe("string");
      expect(err.field.length).toBeGreaterThan(0);
      expect(typeof err.message).toBe("string");
      expect(err.message.length).toBeGreaterThan(0);
    }
  });
});
