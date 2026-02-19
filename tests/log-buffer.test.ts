import { describe, it, expect, vi } from "vitest";
import { LogBuffer } from "../src/log-buffer.js";

function makeLogLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    level: 30,
    time: Date.now(),
    msg: "test message",
    ...overrides,
  });
}

function flush(stream: NodeJS.WritableStream): Promise<void> {
  return new Promise((resolve) => {
    stream.write("", () => resolve());
  });
}

describe("LogBuffer", () => {
  describe("ring buffer", () => {
    it("wraps correctly when buffer is full", async () => {
      const buf = new LogBuffer(3);
      const stream = buf.getStream();

      stream.write(makeLogLine({ msg: "one" }) + "\n");
      stream.write(makeLogLine({ msg: "two" }) + "\n");
      stream.write(makeLogLine({ msg: "three" }) + "\n");
      stream.write(makeLogLine({ msg: "four" }) + "\n");
      await flush(stream);

      const recent = buf.getRecent();
      expect(recent).toHaveLength(3);
      expect(recent[0].msg).toBe("two");
      expect(recent[1].msg).toBe("three");
      expect(recent[2].msg).toBe("four");
    });

    it("returns chronological order after wrap", async () => {
      const buf = new LogBuffer(2);
      const stream = buf.getStream();

      stream.write(makeLogLine({ msg: "a" }) + "\n");
      stream.write(makeLogLine({ msg: "b" }) + "\n");
      stream.write(makeLogLine({ msg: "c" }) + "\n");
      await flush(stream);

      const recent = buf.getRecent();
      expect(recent[0].msg).toBe("b");
      expect(recent[1].msg).toBe("c");
    });
  });

  describe("getRecent", () => {
    it("returns limited count when requested", async () => {
      const buf = new LogBuffer(10);
      const stream = buf.getStream();

      stream.write(makeLogLine({ msg: "a" }) + "\n");
      stream.write(makeLogLine({ msg: "b" }) + "\n");
      stream.write(makeLogLine({ msg: "c" }) + "\n");
      await flush(stream);

      const recent = buf.getRecent(2);
      expect(recent).toHaveLength(2);
      expect(recent[0].msg).toBe("b");
      expect(recent[1].msg).toBe("c");
    });

    it("returns empty array when buffer is empty", () => {
      const buf = new LogBuffer(10);
      expect(buf.getRecent()).toHaveLength(0);
    });
  });

  describe("log event", () => {
    it("emits 'log' event with correct entry", async () => {
      const buf = new LogBuffer(10);
      const stream = buf.getStream();
      const listener = vi.fn();
      buf.on("log", listener);

      stream.write(makeLogLine({ msg: "hello", level: 40 }) + "\n");
      await flush(stream);

      expect(listener).toHaveBeenCalledTimes(1);
      const entry = listener.mock.calls[0][0];
      expect(entry.msg).toBe("hello");
      expect(entry.level).toBe(40);
      expect(entry.levelLabel).toBe("warn");
    });
  });

  describe("component extraction", () => {
    it("extracts 'Daemon: foo' → 'daemon'", async () => {
      const buf = new LogBuffer(10);
      const stream = buf.getStream();
      const listener = vi.fn();
      buf.on("log", listener);

      stream.write(makeLogLine({ msg: "Daemon: starting up" }) + "\n");
      await flush(stream);

      expect(listener.mock.calls[0][0].component).toBe("daemon");
    });

    it("extracts 'Pipeline: bar' → 'pipeline'", async () => {
      const buf = new LogBuffer(10);
      const stream = buf.getStream();
      const listener = vi.fn();
      buf.on("log", listener);

      stream.write(makeLogLine({ msg: "Pipeline: processing task" }) + "\n");
      await flush(stream);

      expect(listener.mock.calls[0][0].component).toBe("pipeline");
    });

    it("falls back to 'app' when no prefix", async () => {
      const buf = new LogBuffer(10);
      const stream = buf.getStream();
      const listener = vi.fn();
      buf.on("log", listener);

      stream.write(makeLogLine({ msg: "no prefix here" }) + "\n");
      await flush(stream);

      expect(listener.mock.calls[0][0].component).toBe("app");
    });
  });

  describe("level mapping", () => {
    it("maps 30 → 'info'", async () => {
      const buf = new LogBuffer(10);
      const stream = buf.getStream();
      const listener = vi.fn();
      buf.on("log", listener);

      stream.write(makeLogLine({ level: 30 }) + "\n");
      await flush(stream);

      expect(listener.mock.calls[0][0].levelLabel).toBe("info");
    });

    it("maps 40 → 'warn'", async () => {
      const buf = new LogBuffer(10);
      const stream = buf.getStream();
      const listener = vi.fn();
      buf.on("log", listener);

      stream.write(makeLogLine({ level: 40 }) + "\n");
      await flush(stream);

      expect(listener.mock.calls[0][0].levelLabel).toBe("warn");
    });

    it("maps 50 → 'error'", async () => {
      const buf = new LogBuffer(10);
      const stream = buf.getStream();
      const listener = vi.fn();
      buf.on("log", listener);

      stream.write(makeLogLine({ level: 50 }) + "\n");
      await flush(stream);

      expect(listener.mock.calls[0][0].levelLabel).toBe("error");
    });
  });

  describe("writable stream", () => {
    it("parses JSON lines and populates buffer", async () => {
      const buf = new LogBuffer(10);
      const stream = buf.getStream();

      const lines =
        [
          makeLogLine({ msg: "first" }),
          makeLogLine({ msg: "second" }),
          makeLogLine({ msg: "third" }),
        ].join("\n") + "\n";

      stream.write(lines);
      await flush(stream);

      const recent = buf.getRecent();
      expect(recent).toHaveLength(3);
      expect(recent[0].msg).toBe("first");
      expect(recent[1].msg).toBe("second");
      expect(recent[2].msg).toBe("third");
    });

    it("handles partial lines split across writes", async () => {
      const buf = new LogBuffer(10);
      const stream = buf.getStream();

      const line = makeLogLine({ msg: "split line" });
      const mid = Math.floor(line.length / 2);

      stream.write(line.substring(0, mid));
      stream.write(line.substring(mid) + "\n");
      await flush(stream);

      const recent = buf.getRecent();
      expect(recent).toHaveLength(1);
      expect(recent[0].msg).toBe("split line");
    });
  });

  describe("taskId and err extraction", () => {
    it("extracts taskId from context", async () => {
      const buf = new LogBuffer(10);
      const stream = buf.getStream();
      const listener = vi.fn();
      buf.on("log", listener);

      stream.write(makeLogLine({ taskId: "42", msg: "task log" }) + "\n");
      await flush(stream);

      expect(listener.mock.calls[0][0].taskId).toBe("42");
    });

    it("extracts err from context", async () => {
      const buf = new LogBuffer(10);
      const stream = buf.getStream();
      const listener = vi.fn();
      buf.on("log", listener);

      stream.write(
        makeLogLine({
          err: { message: "boom", stack: "Error: boom\n  at foo" },
        }) + "\n",
      );
      await flush(stream);

      expect(listener.mock.calls[0][0].err).toContain("boom");
    });

    it("handles string err field", async () => {
      const buf = new LogBuffer(10);
      const stream = buf.getStream();
      const listener = vi.fn();
      buf.on("log", listener);

      stream.write(makeLogLine({ err: "string error" }) + "\n");
      await flush(stream);

      expect(listener.mock.calls[0][0].err).toBe("string error");
    });
  });
});
