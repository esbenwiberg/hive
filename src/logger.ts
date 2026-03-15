import pino from "pino";
import type { DestinationStream } from "pino";
import { Writable } from "node:stream";
import { logBuffer } from "./log-buffer.js";

const isDev = process.env.NODE_ENV !== "production";
const level = process.env.LOG_LEVEL ?? (isDev ? "debug" : "info");

let stdoutStream: DestinationStream = process.stdout;
if (isDev) {
  const pinoPretty = (await import("pino-pretty")).default;
  stdoutStream = pinoPretty({ colorize: true });
}

const streams: Array<{ stream: DestinationStream }> = [
  { stream: stdoutStream },
  { stream: logBuffer.getStream() },
];

// Application Insights pino adapter — forward structured log lines as traces/exceptions.
// Only active when the SDK has been initialized (APPLICATIONINSIGHTS_CONNECTION_STRING set).
try {
  if (process.env.APPLICATIONINSIGHTS_CONNECTION_STRING) {
    const appInsights = await import("applicationinsights");
    const client = appInsights.default.defaultClient;
    if (client) {
      const aiStream = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          try {
            const line = JSON.parse(chunk.toString()) as { level: number; msg?: string; err?: { message?: string; stack?: string } };
            if (line.level >= 50) {
              // error/fatal → trackException
              const error = line.err
                ? Object.assign(new Error(line.err.message ?? line.msg ?? "unknown"), { stack: line.err.stack })
                : new Error(line.msg ?? "unknown error");
              client.trackException({ exception: error });
            } else {
              // info/warn/debug → trackTrace
              const severityMap: Record<number, string> = { 10: "Verbose", 20: "Verbose", 30: "Information", 40: "Warning" };
              client.trackTrace({
                message: line.msg ?? chunk.toString().slice(0, 500),
                severity: severityMap[line.level] ?? "Information",
              });
            }
          } catch { /* parsing failed — skip */ }
          callback();
        },
      });
      streams.push({ stream: aiStream });
    }
  }
} catch { /* applicationinsights not available — skip */ }

const logger = pino(
  { level },
  pino.multistream(streams),
);

export default logger;
