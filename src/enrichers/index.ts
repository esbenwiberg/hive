import type { Enricher } from "./base.js";
import type { AutonomousConfig } from "../domain/autonomous-config.js";
import type { TaskRow } from "../db/schema.js";
import { codebaseEnricher } from "./codebase.js";
import { docsEnricher } from "./docs.js";
import { gitHistoryEnricher } from "./git-history.js";
import { dependenciesEnricher } from "./dependencies.js";
import { prismEnricher } from "./prism.js";
import { architectEnricher } from "./architect.js";
import { scorerEnricher } from "./scorer.js";

// ── All enrichers ───────────────────────────────────────────────────────────

export const ALL_ENRICHERS: Enricher[] = [
  codebaseEnricher,
  docsEnricher,
  gitHistoryEnricher,
  dependenciesEnricher,
  prismEnricher,
  architectEnricher,
  scorerEnricher,
];

// ── Filter by config ────────────────────────────────────────────────────────

/**
 * Returns only enrichers whose name matches an enabled entry
 * in the autonomous config's enrichers array.
 *
 * If the config's enrichers array is empty, all enrichers are returned
 * (default-enabled behaviour).
 */
export function getEnabledEnrichers(config: AutonomousConfig): Enricher[] {
  if (config.enrichers.length === 0) {
    return [...ALL_ENRICHERS];
  }

  const enabledNames = new Set(
    config.enrichers
      .filter((e) => e.enabled)
      .map((e) => e.name),
  );

  return ALL_ENRICHERS.filter((e) => enabledNames.has(e.name));
}

// ── Blueprint-sourced task enrichment ────────────────────────────────────────

/**
 * Returns the full enricher pipeline for a blueprint-sourced task.
 *
 * Blueprint-sourced tasks (`task.blueprint_source === true`) run every
 * enricher without exception:
 *
 * - `codebaseEnricher`, `gitHistoryEnricher`, `dependenciesEnricher`, and
 *   `docsEnricher` gather the same repository context they always would.
 * - `scorerEnricher` (Prism) produces cost/risk estimates as normal — a
 *   blueprint does not bypass scoring.
 * - `architectEnricher` operates in **blueprint validation mode**: it receives
 *   the user-supplied blueprint as context and validates / asks clarifying
 *   questions rather than generating a plan from scratch.  If the architect
 *   is unsatisfied it sets `awaitingInput: true`, putting the task in the
 *   awaiting-input state exactly as it would for a normally-created task.
 *
 * There is intentionally no short-circuit for blueprint tasks.  The full
 * pipeline runs so that the standard approval gate flow is entered after
 * enrichment, regardless of the task's source.
 */
export function getEnrichersForTask(task: TaskRow, config: AutonomousConfig): Enricher[] {
  // Blueprint-sourced tasks always run the full pipeline.  We still respect
  // the config's enabled-enricher list so operators can disable specific
  // enrichers globally, but we never skip enrichers solely because the task
  // has a blueprint source.
  return getEnabledEnrichers(config);
}
