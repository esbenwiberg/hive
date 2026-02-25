import type { Enricher } from "./base.js";
import type { AutonomousConfig } from "../domain/autonomous-config.js";
import { codebaseEnricher } from "./codebase.js";
import { docsEnricher } from "./docs.js";
import { gitHistoryEnricher } from "./git-history.js";
import { dependenciesEnricher } from "./dependencies.js";
import { prismEnricher } from "./prism.js";
import { architectEnricher } from "./architect.js";
import { scorerEnricher } from "./scorer.js";

export {
  parseMarkdownBlueprint,
  BLUEPRINT_MARKDOWN_TEMPLATE,
} from "./external-blueprint.js";
export type { ParseResult } from "./external-blueprint.js";

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

/**
 * Reduced enricher set used for tasks that already have an external blueprint.
 * Codebase, docs, dependencies, and prism enrichers are skipped because the
 * blueprint already captures the relevant context; we only need git-history,
 * architect (validate-only), and scorer.
 * 
 * This is an implementation detail and must not be exported.
 */
const EXTERNAL_BLUEPRINT_ENRICHERS: Enricher[] = [
  gitHistoryEnricher,
  architectEnricher,
  scorerEnricher,
];

// ── Select enrichers based on task ─────────────────────────────────────────

/**
 * Returns the appropriate enricher list for a task based on its
 * `blueprintSource` field.  Tasks with `blueprintSource === "external"` use
 * the reduced {@link EXTERNAL_BLUEPRINT_ENRICHERS} set; all other tasks use
 * the full {@link ALL_ENRICHERS} list.
 *
 * Always returns a new array so callers can mutate it safely.
 */
export function getEnrichersForTask(task: { blueprintSource?: string }): Enricher[] {
  if (task.blueprintSource === "external") {
    return [...EXTERNAL_BLUEPRINT_ENRICHERS];
  }
  return [...ALL_ENRICHERS];
}

/**
 * Like {@link getEnrichersForTask} but further filters the result by the
 * enabled enrichers declared in the autonomous config.
 *
 * If the config's enrichers array is empty every enricher selected by
 * `getEnrichersForTask` is returned unchanged (default-enabled behaviour).
 */
export function getEnrichersForTaskWithConfig(
  task: { blueprintSource?: string },
  config: AutonomousConfig,
): Enricher[] {
  const candidates = getEnrichersForTask(task);

  if (config.enrichers.length === 0) {
    return candidates;
  }

  const enabledNames = new Set(
    config.enrichers
      .filter((e) => e.enabled)
      .map((e) => e.name),
  );

  return candidates.filter((e) => enabledNames.has(e.name));
}

// ── Filter by config (legacy) ───────────────────────────────────────────────

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
