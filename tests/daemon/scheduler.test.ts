import { describe, it, expect, vi, afterEach } from "vitest";

// Mock the logger
vi.mock("../../src/logger.js", () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

const { Scheduler } = await import("../../src/daemon/scheduler.js");

describe("Scheduler", () => {
  let scheduler: InstanceType<typeof Scheduler>;

  afterEach(() => {
    scheduler?.stop();
  });

  it("calls the tick callback on each interval", async () => {
    const tick = vi.fn().mockResolvedValue(undefined);
    scheduler = new Scheduler(50, tick);
    scheduler.start();

    await new Promise((r) => setTimeout(r, 180));
    scheduler.stop();

    expect(tick.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("skips overlapping ticks", async () => {
    let callCount = 0;
    const tick = vi.fn().mockImplementation(async () => {
      callCount++;
      // Simulate slow work (200ms) on first call
      if (callCount === 1) {
        await new Promise((r) => setTimeout(r, 200));
      }
    });

    scheduler = new Scheduler(50, tick);
    scheduler.start();

    // Wait 300ms — enough for the slow first tick to finish + a few more ticks to fire
    await new Promise((r) => setTimeout(r, 300));
    scheduler.stop();

    // The first tick takes 200ms, so during that time subsequent ticks are skipped.
    // After it finishes, more ticks can run. Total should be less than 300/50 = 6.
    expect(tick.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(tick.mock.calls.length).toBeLessThan(6);
  });

  it("stops preventing further ticks", async () => {
    const tick = vi.fn().mockResolvedValue(undefined);
    scheduler = new Scheduler(50, tick);
    scheduler.start();

    await new Promise((r) => setTimeout(r, 80));
    scheduler.stop();

    const countAfterStop = tick.mock.calls.length;
    await new Promise((r) => setTimeout(r, 120));

    // No new ticks after stop
    expect(tick.mock.calls.length).toBe(countAfterStop);
  });

  it("start is idempotent", () => {
    const tick = vi.fn().mockResolvedValue(undefined);
    scheduler = new Scheduler(1000, tick);
    scheduler.start();
    scheduler.start(); // Second call should be a no-op
    scheduler.stop();
  });
});
