/**
 * Ambient type declarations for the optional @prism/core dependency.
 * The package is dynamically imported with try/catch guards so it may
 * not be installed; these stubs keep TypeScript happy.
 */
declare module "@prism/core" {
  export interface Project {
    id: string;
    indexStatus?: string;
    slug?: string | null;
    [key: string]: unknown;
  }

  export interface PipelineOptions {
    layers?: string[];
    fullReindex?: boolean;
  }

  export interface Embedder {
    embed(texts: string[]): Promise<number[][]>;
  }

  export interface SimilarityResult {
    targetId: string;
    filePath: string | null;
    symbolName: string | null;
    symbolKind: string | null;
    level: string;
    summaryContent: string;
    score: number;
    [key: string]: unknown;
  }

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
    suggestion: string | null;
    [key: string]: unknown;
  }

  export function setActiveConnectionString(url: string): void;
  export function getProjectByPath(path: string): Promise<Project | null>;
  export function getProjectBySlug(slug: string): Promise<Project | null>;
  export function runPipeline(project: Project, options?: PipelineOptions): Promise<void>;
  export function createEmbedder(options?: Record<string, unknown>): Embedder;
  export function simpleSimilaritySearch(
    projectId: string,
    embedding: number[],
    limit?: number,
  ): Promise<SimilarityResult[]>;
  export function getSummariesByLevel(
    projectId: string,
    level: string,
  ): Promise<SummaryResult[]>;
  export function getFindingsByProjectId(
    projectId: string,
  ): Promise<FindingResult[]>;
}
