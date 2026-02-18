import { getAutonomousConfig } from "../domain/autonomous-config.js";

/**
 * Estimates the cost in USD for a given number of input and output tokens.
 *
 * When per-million costs are not provided, reads them from the autonomous config.
 */
export function estimateCostUsd(
  inputTokens: number,
  outputTokens: number,
  inputCostPerM?: number,
  outputCostPerM?: number,
): number {
  if (inputCostPerM === undefined || outputCostPerM === undefined) {
    const config = getAutonomousConfig();
    inputCostPerM = inputCostPerM ?? config.models.inputCostPerM;
    outputCostPerM = outputCostPerM ?? config.models.outputCostPerM;
  }
  return (inputTokens * inputCostPerM + outputTokens * outputCostPerM) / 1_000_000;
}
