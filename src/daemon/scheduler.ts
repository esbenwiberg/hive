import logger from "../logger.js";

/**
 * A simple interval scheduler with mutual-exclusion:
 * if the previous tick is still running, the new tick is skipped.
 */
export class Scheduler {
  private readonly intervalMs: number;
  private readonly tick: () => Promise<void>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(intervalMs: number, tick: () => Promise<void>) {
    this.intervalMs = intervalMs;
    this.tick = tick;
  }

  start(): void {
    if (this.timer) return;

    this.timer = setInterval(() => {
      void this.onTick();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async onTick(): Promise<void> {
    if (this.running) {
      logger.debug("Scheduler tick skipped: previous tick still running");
      return;
    }

    this.running = true;
    try {
      await this.tick();
    } finally {
      this.running = false;
    }
  }
}
