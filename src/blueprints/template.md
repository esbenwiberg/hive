# Hive Blueprint Template

Use this template when creating a task directly from a blueprint. Copy it, fill in your own details, and paste into the blueprint field when creating a task.

---

## Approach

High-level description of your implementation strategy. Explain:
- What problem this solves or what feature this adds
- Why you chose this approach (over alternatives)
- Which layers of the codebase are involved (backend, frontend, database, etc.)

Keep this 2-5 sentences; think of it as an executive summary.

---

## Milestone 1: Parse and validate the feature schema

One or two sentences describing what this milestone delivers and how it contributes to the overall approach. Be specific about the outcome.

### Files to Modify

List files that will be changed or created in this milestone:

- `src/domain/types.ts`
- `src/blueprints/parser.ts`
- `tests/blueprints/parser.test.ts`

### Acceptance Criteria

Independent, observable criteria that confirm this milestone is complete. Each criterion should be testable without subjective judgment:

- Parser extracts approach section and milestone blocks correctly from valid markdown
- Parser returns structured validation errors for invalid format
- Unit tests cover happy path and all error cases
- TypeScript compilation passes with no new errors
- All new functions have JSDoc comments

---

## Milestone 2: Database and domain extensions

What this milestone achieves.

### Files to Modify

- `src/db/schema.ts`
- `src/domain/types.ts`
- `drizzle/NNNN_blueprint_support.sql`

### Acceptance Criteria

- Database schema includes `userBlueprintMarkdown` and `blueprintSource` columns
- Existing task queries continue to pass
- Domain types reflect the new schema
- TypeScript compilation passes
- Migration runs without errors

---

## Milestone 3: Architect enricher blueprint validation mode

What this milestone achieves.

### Files to Modify

- `src/enrichers/architect.ts`
- `prompts/enrichers/architect.md`

### Acceptance Criteria

- Architect detects `blueprintSource === 'user'` and calls parser
- Architect prompt includes validation/clarification instructions
- Invalid blueprints cause enricher to throw with validation errors
- Valid blueprints are refined and output as normal
- Existing architect tests continue to pass

---

## Milestone 4: Dashboard UI for blueprint input

Add blueprint form controls to task creation.

### Files to Modify

- `src/dashboard/views/tasks.ts`
- `src/dashboard/routes/tasks.ts`

### Acceptance Criteria

- Create form has a "Provide blueprint" toggle
- Blueprint textarea appears when toggle is enabled
- Template helper shows canonical format
- Server validates blueprint before task creation
- Validation errors render inline in the form
- Normal task creation (non-blueprint) flow is unchanged

---

## Milestone 5: End-to-end wiring and documentation

Integrate all pieces and ensure full pipeline support.

### Files to Modify

- `src/enrichers/index.ts`
- `docs/internal/modules/agents.md`

### Acceptance Criteria

- All enrichers run for blueprint-sourced tasks
- Scorer, architect, and gate work with blueprint tasks
- Clarification questions work for blueprint tasks
- Architect behavior documented in module guide
- Blueprint template file exists at canonical location
- Full build and test suite passes
