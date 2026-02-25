/**
 * Shared type definitions for agents module.
 */

export type AdvisorVerdict = 'approve' | 'caution' | 'rework';

export interface AdvisorVerdictResponse {
  verdict: AdvisorVerdict;
  confidenceScore: number; // Strictly [0.0, 1.0]
  escalate: boolean;
  dimensions: Record<string, number>; // All values in [0.0, 1.0]
  reasoning: string; // Max 5000 chars
  recommendations: string[]; // Each < 1000 chars
}
