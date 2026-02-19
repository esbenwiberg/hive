import { EventEmitter } from "node:events";
import { Writable } from "node:stream";

export interface LogEntry {
  level: number;
  levelLabel: string;
  time: number;
  msg: string;
  component: string;
  taskId?: string;
  err?: string;
  raw: string;
}

const LEVEL_LABELS: Record<number, string> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};

const COMPONENT_RE = /^([\w][\w -]*?):\s/;
const DEFAULT_BUFFER_SIZE = 500;

export class LogBuffer extends EventEmitter {
  private buffer: LogEntry[];
  private maxSize: number;
  private head = 0;
  private count = 0;
  private writable: Writable | null = null;

  constructor(maxSize?: number) {
    super();
    this.maxSize =
      maxSize ?? (Number(process.env.HIVE_LOG_BUFFER_SIZE) || DEFAULT_BUFFER_SIZE);
    this.buffer = new Array(this.maxSize);
    this.setMaxListeners(0);
  }

  getStream(): Writable {
    if (this.writable) return this.writable;

    let partial = "";

    this.writable = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        const data = partial + chunk.toString();
        const lines = data.split("\n");
        partial = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            const entry = this.parseEntry(parsed, line);
            this.push(entry);
          } catch {
            // Skip unparseable lines
          }
        }
        callback();
      },
    });

    return this.writable;
  }

  getRecent(count?: number): LogEntry[] {
    const n = Math.min(count ?? this.count, this.count);
    const result: LogEntry[] = [];
    const start = (this.head - n + this.maxSize) % this.maxSize;

    for (let i = 0; i < n; i++) {
      const idx = (start + i) % this.maxSize;
      result.push(this.buffer[idx]);
    }

    return result;
  }

  private push(entry: LogEntry): void {
    this.buffer[this.head] = entry;
    this.head = (this.head + 1) % this.maxSize;
    if (this.count < this.maxSize) this.count++;
    this.emit("log", entry);
  }

  private parseEntry(obj: Record<string, unknown>, raw: string): LogEntry {
    const level = typeof obj.level === "number" ? obj.level : 30;
    const msg = typeof obj.msg === "string" ? obj.msg : "";

    const match = COMPONENT_RE.exec(msg);
    const component = match ? match[1].toLowerCase() : "app";

    const taskId = typeof obj.taskId === "string" ? obj.taskId : undefined;

    let err: string | undefined;
    if (obj.err && typeof obj.err === "object") {
      const errObj = obj.err as Record<string, unknown>;
      err =
        typeof errObj.message === "string"
          ? errObj.message
          : JSON.stringify(obj.err);
      if (typeof errObj.stack === "string") {
        err = errObj.stack;
      }
    } else if (typeof obj.err === "string") {
      err = obj.err;
    }

    return {
      level,
      levelLabel: LEVEL_LABELS[level] ?? "info",
      time: typeof obj.time === "number" ? obj.time : Date.now(),
      msg,
      component,
      taskId,
      err,
      raw,
    };
  }
}

export const logBuffer = new LogBuffer();
