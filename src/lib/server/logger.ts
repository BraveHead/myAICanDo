import "server-only";

import { Writable } from "node:stream";
import pino, {
  type DestinationStream,
  type Level,
  type Logger,
  type LoggerOptions,
  type StreamEntry,
} from "pino";
import {
  createLogFileDestinations,
  getLogFileConfig,
} from "./log-file-stream";

export type LogContext = Record<string, unknown>;

const REDACT_PATHS = [
  "apiKey",
  "*.apiKey",
  "authorization",
  "*.authorization",
  "headers.authorization",
  "cookie",
  "*.cookie",
  "headers.cookie",
  "session",
  "*.session",
  "password",
  "*.password",
  "DATABASE_URL",
  "databaseUrl",
  "*.databaseUrl",
  "connectionString",
  "*.connectionString",
];

const LOG_LEVELS = new Set([
  "fatal",
  "error",
  "warn",
  "info",
  "debug",
  "trace",
  "silent",
]);

let appLogger: Logger | null = null;

export function getLogger() {
  if (!appLogger) {
    const fileConfig = getLogFileConfig();
    const fileDestinations = createLogFileDestinations(fileConfig);
    appLogger = pino(
      createLoggerOptions(),
      createLoggerDestination(fileConfig.stdout, fileDestinations),
    );
    appLogger.info(
      compactLogContext({
        component: "logger",
        logDir: fileDestinations?.directory,
        logFileIncludePid: fileConfig.includePid,
        logFileRequired: fileConfig.required,
        logRetentionDays: fileConfig.retentionDays,
        logToFile: fileConfig.enabled,
        logToStdout: fileConfig.stdout,
        maxFileSizeBytes: fileConfig.maxFileSizeBytes,
      }),
      "logger initialized",
    );
  }

  return appLogger;
}

export const logger = getLogger();

export function createRequestLogger(baseFields: LogContext) {
  return getLogger().child(compactLogContext(baseFields));
}

export function compactLogContext(context: LogContext) {
  return Object.fromEntries(
    Object.entries(context).filter(([, value]) => value !== undefined),
  );
}

export function toLogError(error: unknown) {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }

  return {
    message: String(error),
    name: typeof error,
  };
}

function createLoggerOptions(): LoggerOptions {
  return {
    base: {
      app: "my-ai-can-do",
      env: process.env.NODE_ENV || "development",
    },
    formatters: {
      level(label) {
        return { level: label };
      },
    },
    level: resolveLogLevel(),
    name: "my-ai-can-do",
    redact: {
      censor: "[Redacted]",
      paths: REDACT_PATHS,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
}

function createLoggerDestination(
  stdoutEnabled: boolean,
  fileDestinations: ReturnType<typeof createLogFileDestinations>,
) {
  const streams: StreamEntry<Level>[] = [];

  if (stdoutEnabled) {
    streams.push({
      level: "trace",
      stream: process.stdout as DestinationStream,
    });
  }

  if (fileDestinations) {
    streams.push(
      {
        level: "trace",
        stream: fileDestinations.appStream as DestinationStream,
      },
      {
        level: "warn",
        stream: fileDestinations.errorStream as DestinationStream,
      },
    );
  }

  if (streams.length === 0) {
    return new NullLogStream() as DestinationStream;
  }

  return streams.length === 1
    ? streams[0].stream
    : pino.multistream(streams, { dedupe: false });
}

function resolveLogLevel() {
  const configuredLevel = process.env.LOG_LEVEL?.trim().toLowerCase();
  if (configuredLevel && LOG_LEVELS.has(configuredLevel)) {
    return configuredLevel;
  }

  return process.env.NODE_ENV === "development" ? "debug" : "info";
}

class NullLogStream extends Writable {
  override _write(
    _chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    callback();
  }
}
