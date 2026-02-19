import pino from "pino";
import type { DestinationStream } from "pino";
import { logBuffer } from "./log-buffer.js";

const isDev = process.env.NODE_ENV !== "production";
const level = process.env.LOG_LEVEL ?? (isDev ? "debug" : "info");

let stdoutStream: DestinationStream = process.stdout;
if (isDev) {
  const pinoPretty = (await import("pino-pretty")).default;
  stdoutStream = pinoPretty({ colorize: true });
}

const logger = pino(
  { level },
  pino.multistream([
    { stream: stdoutStream },
    { stream: logBuffer.getStream() },
  ]),
);

export default logger;
