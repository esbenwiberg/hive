import logger from "../logger.js";

export interface RetryOptions {
  /** Max number of attempts (including the first try). Default: 3 */
  maxAttempts?: number;
  /** Base delay in ms before first retry. Default: 1000 */
  baseDelayMs?: number;
  /** Multiplier for each subsequent retry. Default: 2 */
  backoffMultiplier?: number;
  /** Optional label for logging. */
  label?: string;
  /** Optional predicate — only retry if this returns true for the error. */
  shouldRetry?: (err: unknown) => boolean;
}

/**
 * Retries an async operation with exponential backoff.
 * Only retries on transient/network errors by default.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelayMs = 1_000,
    backoffMultiplier = 2,
    label = "operation",
    shouldRetry = isTransientError,
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (attempt >= maxAttempts || !shouldRetry(err)) {
        throw err;
      }

      const delayMs = baseDelayMs * Math.pow(backoffMultiplier, attempt - 1);
      logger.warn(
        { attempt, maxAttempts, delayMs, label, err },
        "Retryable error — backing off before retry",
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

/**
 * Determines if an error is likely transient and worth retrying.
 * Covers network errors, timeouts, and common HTTP transient status codes.
 */
function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;

  const message = err.message.toLowerCase();

  // Network-level errors
  if (
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("etimedout") ||
    message.includes("enotfound") ||
    message.includes("epipe") ||
    message.includes("socket hang up") ||
    message.includes("fetch failed")
  ) {
    return true;
  }

  // HTTP transient status codes (429, 500, 502, 503, 504)
  if (
    message.includes("(429)") ||
    message.includes("(500)") ||
    message.includes("(502)") ||
    message.includes("(503)") ||
    message.includes("(504)") ||
    message.includes("too many requests") ||
    message.includes("service unavailable") ||
    message.includes("bad gateway") ||
    message.includes("gateway timeout")
  ) {
    return true;
  }

  // Azure-specific transient errors
  if (
    message.includes("throttled") ||
    message.includes("temporarily unavailable")
  ) {
    return true;
  }

  return false;
}
