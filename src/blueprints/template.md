# Hive Blueprint Template

> **How to use this template**
>
> 1. Copy everything from the `## Approach` heading downward.
> 2. Fill in every section marked with `<angle brackets>`.
> 3. Remove placeholder angle-bracket lines once you have replaced them.
> 4. Keep the heading names **exactly** as shown — the parser is case-insensitive
>    but requires `## Approach`, `## Milestone N: …`, `### Acceptance Criteria`,
>    and optionally `### Files to Modify`.
> 5. Paste the completed text into the Hive dashboard's **"Create from Blueprint"**
>    text area and submit. Hive will validate the format, run all enrichers
>    (including the architect in validation mode), and route the task through the
>    normal approval gate.
>
> **Validation rules** — your blueprint will be rejected if:
> - The `## Approach` section is missing or empty.
> - There are no `## Milestone …` sections.
> - Any milestone is missing a title (e.g. `## Milestone 1: My Title`).
> - Any milestone is missing an `### Acceptance Criteria` sub-section with at
>   least one bullet point (`-`, `*`, or `+`).
> - Any milestone has no paragraph text or `### Description` sub-section.

---

## Approach

<
Write 2–5 sentences describing the overall implementation strategy.
Explain *why* you chose this approach, which layers of the stack are involved,
and any non-obvious trade-offs or constraints that informed the design.
Remove this angle-bracket block and replace it with your own text.
>

---

## Milestone 1: <Short imperative title>

<
One or two sentences explaining what this milestone delivers and why it is
scoped the way it is. This paragraph becomes the milestone description.
Replace this block with your own description — do not leave angle brackets in
the final blueprint.
>

### Files to Modify

- `<src/path/to/file.ts>`
- `<src/path/to/another-file.ts>`

### Acceptance Criteria

- <Observable, testable outcome that confirms this milestone is complete.>
- <Another independently verifiable criterion.>

---

## Milestone 2: <Short imperative title>

<
Description of what this milestone delivers.
>

### Files to Modify

- `<src/path/to/file.ts>`

### Acceptance Criteria

- <Criterion — written so a reviewer can confirm it without running the full suite.>
- <Another criterion.>

---

<!-- Add as many ## Milestone N: … blocks as needed. -->

---

## Notes

<!-- optional — anything the architect or reviewers should know that doesn't
     fit neatly into the milestones above. Examples:

     - Rollback plan if the migration fails
     - Environment variables that must be set before deployment
     - External dependencies or third-party APIs involved
     - Open questions you want the architect to answer

     If you have no notes, delete this entire section. -->
