import logger from "../../logger.js";
import { addPreviewLog } from "../../db/queries/preview-logs.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ValidationCheck {
  endpoint: string;
  status: number;
  passed: boolean;
  notes: string;
}

export interface ValidationResult {
  passed: boolean;
  checks: ValidationCheck[];
}

// ── Constants ────────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 10_000;

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Validates a preview environment by making HTTP requests to verify it is working.
 * Hits the health-check path (expects 200) and optionally the root path.
 * Logs results to preview_logs.
 */
export async function validatePreview(
  taskId: string,
  previewUrl: string,
  healthCheckPath: string,
): Promise<ValidationResult> {
  const checks: ValidationCheck[] = [];

  // 1. Health-check endpoint
  const healthUrl = `${previewUrl}${healthCheckPath}`;
  const healthCheck = await checkEndpoint(healthUrl);
  checks.push(healthCheck);

  // 2. Root path (optional, only if health-check path is not already "/")
  if (healthCheckPath !== "/") {
    const rootUrl = `${previewUrl}/`;
    const rootCheck = await checkEndpoint(rootUrl);
    checks.push(rootCheck);
  }

  const passed = checks.every((c) => c.passed);

  // Log the result
  const summary = passed
    ? `Validation passed: ${checks.length} check(s) OK`
    : `Validation failed: ${checks.filter((c) => !c.passed).length}/${checks.length} check(s) failed`;

  await addPreviewLog(taskId, "validator", summary);

  logger.info(
    { taskId, passed, checks: checks.length },
    `Preview validation ${passed ? "passed" : "failed"}`,
  );

  return { passed, checks };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Makes a GET request to the given URL and returns a ValidationCheck result.
 */
async function checkEndpoint(url: string): Promise<ValidationCheck> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const passed = response.status === 200;
    const notes = passed
      ? "OK"
      : `Unexpected status ${response.status}`;

    return { endpoint: url, status: response.status, passed, notes };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { endpoint: url, status: 0, passed: false, notes: `Request failed: ${reason}` };
  }
}
