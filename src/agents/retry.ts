// ── Exponential Backoff ──────────────────────────────────────────────────────

export interface RetryOptions {
  /** Maximum number of retry attempts (default 3). */
  maxRetries?: number;
  /** Base delay in milliseconds (default 1000). */
  baseDelayMs?: number;
  /** Whether to add random jitter to the delay (default true). */
  jitter?: boolean;
}

const DEFAULT_RETRY: Required<RetryOptions> = {
  maxRetries: 5,
  baseDelayMs: 2000,
  jitter: true,
};

/**
 * Sleeps for the given number of milliseconds.
 * Extracted so tests can override it to avoid real delays.
 */
export let sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Allows tests to replace the sleep implementation. */
export function setSleep(fn: (ms: number) => Promise<void>): void {
  sleep = fn;
}

/**
 * Executes `fn` with exponential backoff.
 * The delay doubles each attempt: baseDelay * 2^attempt.
 * When jitter is enabled a random fraction (0-1) of the computed delay is added.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const { maxRetries, baseDelayMs, jitter } = { ...DEFAULT_RETRY, ...opts };

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (attempt === maxRetries) break;

      let delay = baseDelayMs * Math.pow(2, attempt);
      if (jitter) {
        delay += Math.random() * delay;
      }
      await sleep(delay);
    }
  }

  throw lastError;
}

// ── Circuit Breaker ──────────────────────────────────────────────────────────

export interface CircuitBreakerOptions {
  /** Number of consecutive failures before the circuit opens (default 5). */
  failureThreshold?: number;
  /** Time in milliseconds before the circuit transitions from open to half-open (default 30000). */
  resetTimeoutMs?: number;
}

export type CircuitState = "closed" | "open" | "half-open";

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failures = 0;
  private lastFailureTime = 0;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.resetTimeoutMs = opts.resetTimeoutMs ?? 30_000;
  }

  getState(): CircuitState {
    if (this.state === "open") {
      // Check if enough time has passed to try again
      if (Date.now() - this.lastFailureTime >= this.resetTimeoutMs) {
        this.state = "half-open";
      }
    }
    return this.state;
  }

  /**
   * Executes `fn` through the circuit breaker.
   * - **closed**: calls proceed normally; consecutive failures increment the counter.
   * - **open**: calls are immediately rejected until the reset timeout elapses.
   * - **half-open**: one call is allowed through; success closes the circuit, failure re-opens it.
   */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    const current = this.getState();

    if (current === "open") {
      throw new Error("Circuit breaker is open");
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      this.onFailure();
      throw err;
    }
  }

  private onSuccess(): void {
    this.failures = 0;
    this.state = "closed";
  }

  private onFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();

    if (this.failures >= this.failureThreshold) {
      this.state = "open";
    }
  }
}
