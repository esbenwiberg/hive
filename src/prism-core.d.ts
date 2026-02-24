/**
 * Ambient type declaration for the optional `@prism/core` package.
 *
 * The package is lazily imported at runtime and may not be installed in all
 * environments.  TypeScript only needs enough structural information to type-
 * check the call-sites; the actual implementation is provided by the package
 * itself when it is present.
 */
declare module "@prism/core" {
  export interface PrismProject {
    id: string;
    indexStatus: string;
    [key: string]: unknown;
  }

  export interface EmbedderConfig {
    enabled: boolean;
    model: string;
    embeddingProvider: string;
    embeddingModel: string;
    embeddingDimensions: number;
    budgetUsd: number;
  }

  export interface Embedder {
    embed(texts: string[]): Promise<number[][]>;
  }

  export interface SimilarityResult {
    targetId: string;
    filePath: string;
    symbolName: string;
    symbolKind: string;
    level: string;
    summaryContent: string;
    score: number;
    [key: string]: unknown;
  }

  export interface RunPipelineOptions {
    layers: string[];
    fullReindex: boolean;
  }

  export function setActiveConnectionString(connectionString: string): void;
  export function getProjectByPath(path: string): Promise<PrismProject | null>;
  export function runPipeline(project: PrismProject, options: RunPipelineOptions): Promise<void>;
  export function createEmbedder(config: EmbedderConfig): Embedder;
  export interface SummaryResult {
    targetId: string;
    content: string;
    [key: string]: unknown;
  }

  export interface FindingResult {
    category: string;
    severity: string;
    title: string;
    description: string;
    suggestion: string;
    [key: string]: unknown;
  }

  export function simpleSimilaritySearch(
    projectId: string,
    queryVector: number[],
    limit: number,
  ): Promise<SimilarityResult[]>;
  export function getSummariesByLevel(
    projectId: string,
    level: string,
  ): Promise<SummaryResult[]>;
  export function getFindingsByProjectId(projectId: string): Promise<FindingResult[]>;
}
