import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  withRetry,
  setSleep,
  CircuitBreaker,
} from "../../src/agents/retry.js";

// ── Replace sleep with a no-op so tests run instantly ────────────────────────

beforeEach(() => {
  setSleep(async () => {});
});

// ── withRetry ────────────────────────────────────────────────────────────────

describe("withRetry", () => {
  it("returns the result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");

    const result = await withRetry(fn);

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on failure and returns on eventual success", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("fail-1"))
      .mockRejectedValueOnce(new Error("fail-2"))
      .mockResolvedValue("ok");

    const result = await withRetry(fn, { maxRetries: 3 });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws after exhausting all retries", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("always-fail"));

    await expect(
      withRetry(fn, { maxRetries: 2 }),
    ).rejects.toThrow("always-fail");

    // 1 initial + 2 retries = 3 calls
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("respects maxRetries = 0 (no retries)", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("fail"));

    await expect(withRetry(fn, { maxRetries: 0 })).rejects.toThrow("fail");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("calls sleep between retries with exponential delays", async () => {
    const delays: number[] = [];
    setSleep(async (ms: number) => {
      delays.push(ms);
    });

    const fn = vi.fn().mockRejectedValue(new Error("fail"));

    await expect(
      withRetry(fn, { maxRetries: 3, baseDelayMs: 100, jitter: false }),
    ).rejects.toThrow("fail");

    // Delays: 100 * 2^0 = 100, 100 * 2^1 = 200, 100 * 2^2 = 400
    expect(delays).toEqual([100, 200, 400]);
  });

  it("adds jitter when enabled", async () => {
    const delays: number[] = [];
    setSleep(async (ms: number) => {
      delays.push(ms);
    });

    const fn = vi.fn().mockRejectedValue(new Error("fail"));

    await expect(
      withRetry(fn, { maxRetries: 2, baseDelayMs: 100, jitter: true }),
    ).rejects.toThrow("fail");

    // With jitter, delays should be >= base * 2^attempt (jitter adds 0-1x of delay)
    expect(delays[0]).toBeGreaterThanOrEqual(100);
    expect(delays[0]).toBeLessThan(200); // max is 100 + 100*1 = 200
    expect(delays[1]).toBeGreaterThanOrEqual(200);
    expect(delays[1]).toBeLessThan(400); // max is 200 + 200*1 = 400
  });
});

// ── CircuitBreaker ───────────────────────────────────────────────────────────

describe("CircuitBreaker", () => {
  it("starts in closed state", () => {
    const cb = new CircuitBreaker();
    expect(cb.getState()).toBe("closed");
  });

  it("stays closed when calls succeed", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });

    await cb.call(async () => "ok");
    await cb.call(async () => "ok");

    expect(cb.getState()).toBe("closed");
  });

  it("opens after reaching failure threshold", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    const failing = async () => {
      throw new Error("fail");
    };

    for (let i = 0; i < 3; i++) {
      await expect(cb.call(failing)).rejects.toThrow("fail");
    }

    expect(cb.getState()).toBe("open");
  });

  it("rejects calls immediately when open", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 60_000 });

    await expect(
      cb.call(async () => {
        throw new Error("fail");
      }),
    ).rejects.toThrow("fail");

    expect(cb.getState()).toBe("open");

    await expect(
      cb.call(async () => "should not run"),
    ).rejects.toThrow("Circuit breaker is open");
  });

  it("transitions to half-open after reset timeout", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 50 });

    await expect(
      cb.call(async () => {
        throw new Error("fail");
      }),
    ).rejects.toThrow("fail");

    expect(cb.getState()).toBe("open");

    // Wait for reset timeout
    await new Promise((r) => setTimeout(r, 60));

    expect(cb.getState()).toBe("half-open");
  });

  it("closes again after a successful call in half-open state", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 50 });

    await expect(
      cb.call(async () => {
        throw new Error("fail");
      }),
    ).rejects.toThrow("fail");

    await new Promise((r) => setTimeout(r, 60));
    expect(cb.getState()).toBe("half-open");

    await cb.call(async () => "recovered");
    expect(cb.getState()).toBe("closed");
  });

  it("re-opens if a call fails in half-open state", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 50 });

    await expect(
      cb.call(async () => {
        throw new Error("fail");
      }),
    ).rejects.toThrow("fail");

    await new Promise((r) => setTimeout(r, 60));
    expect(cb.getState()).toBe("half-open");

    await expect(
      cb.call(async () => {
        throw new Error("still broken");
      }),
    ).rejects.toThrow("still broken");

    expect(cb.getState()).toBe("open");
  });

  it("resets failure counter on success", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });

    // 2 failures, then a success should reset the counter
    await expect(cb.call(async () => { throw new Error("f"); })).rejects.toThrow();
    await expect(cb.call(async () => { throw new Error("f"); })).rejects.toThrow();
    await cb.call(async () => "ok");

    // 2 more failures should not open (counter was reset)
    await expect(cb.call(async () => { throw new Error("f"); })).rejects.toThrow();
    await expect(cb.call(async () => { throw new Error("f"); })).rejects.toThrow();

    expect(cb.getState()).toBe("closed");
  });
});
