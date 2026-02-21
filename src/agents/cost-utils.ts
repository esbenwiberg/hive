import { getAutonomousConfig } from "../domain/autonomous-config.js";

/**
 * Estimates the cost in USD for a given number of input and output tokens.
 *
 * When per-million costs are not provided, reads them from the autonomous config.
 * Cache-aware: cache writes cost 1.25x base input, cache reads cost 0.1x base input.
 */
export function estimateCostUsd(
  inputTokens: number,
  outputTokens: number,
  inputCostPerM?: number,
  outputCostPerM?: number,
  cacheCreationInputTokens?: number,
  cacheReadInputTokens?: number,
): number {
  if (inputCostPerM === undefined || outputCostPerM === undefined) {
    const config = getAutonomousConfig();
    inputCostPerM = inputCostPerM ?? config.models.inputCostPerM;
    outputCostPerM = outputCostPerM ?? config.models.outputCostPerM;
  }
  let cost = (inputTokens * inputCostPerM + outputTokens * outputCostPerM) / 1_000_000;
  if (cacheCreationInputTokens) {
    cost += (cacheCreationInputTokens * inputCostPerM * 1.25) / 1_000_000;
  }
  if (cacheReadInputTokens) {
    cost += (cacheReadInputTokens * inputCostPerM * 0.1) / 1_000_000;
  }
  return cost;
}
