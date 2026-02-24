import type { Enricher } from "./base.js";
import type { AutonomousConfig } from "../domain/autonomous-config.js";
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
