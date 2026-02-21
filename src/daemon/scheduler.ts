import logger from "../logger.js";

const DEFAULT_TICK_TIMEOUT_MS = 5 * 60 * 1_000; // 5 minutes

/**
 * A simple interval scheduler with mutual-exclusion:
 * if the previous tick is still running, the new tick is skipped.
 * A per-tick timeout prevents a hung tick from blocking all future ticks.
 */
export class Scheduler {
  private readonly intervalMs: number;
  private readonly tick: () => Promise<void>;
  private readonly tickTimeoutMs: number;
  private readonly initialDelayMs: number;
  private readonly label: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private delayTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    intervalMs: number,
    tick: () => Promise<void>,
    opts?: { tickTimeoutMs?: number; label?: string; initialDelayMs?: number },
  ) {
    this.intervalMs = intervalMs;
    this.tick = tick;
    this.tickTimeoutMs = opts?.tickTimeoutMs ?? DEFAULT_TICK_TIMEOUT_MS;
    this.initialDelayMs = opts?.initialDelayMs ?? 0;
    this.label = opts?.label ?? "Scheduler";
  }

  start(): void {
    if (this.timer || this.delayTimer) return;

    const begin = () => {
      this.delayTimer = null;
      this.timer = setInterval(() => {
        void this.onTick();
      }, this.intervalMs);
    };

    if (this.initialDelayMs > 0) {
      this.delayTimer = setTimeout(begin, this.initialDelayMs);
    } else {
      begin();
    }
  }

  async stop(): Promise<void> {
    if (this.delayTimer) {
      clearTimeout(this.delayTimer);
      this.delayTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Wait for any in-flight tick to complete
    while (this.running) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  private async onTick(): Promise<void> {
    if (this.running) {
      logger.debug({ label: this.label }, "Scheduler tick skipped: previous tick still running");
      return;
    }

    this.running = true;
    try {
      await Promise.race([
        this.tick(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`${this.label}: tick timed out after ${this.tickTimeoutMs}ms`)),
            this.tickTimeoutMs,
          ),
        ),
      ]);
    } catch (err) {
      logger.error({ err, label: this.label }, "Scheduler tick failed");
    } finally {
      this.running = false;
    }
  }
}
