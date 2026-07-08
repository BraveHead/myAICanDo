import "server-only";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";

type RotatingLogFileStreamOptions = {
  directory: string;
  includePid: boolean;
  maxFileSizeBytes: number;
  prefix: "app" | "error";
};

export type LogFileConfig = {
  directory: string;
  enabled: boolean;
  includePid: boolean;
  maxFileSizeBytes: number;
  required: boolean;
  retentionDays: number;
  stdout: boolean;
};

export type LogFileDestinations = {
  appStream: Writable;
  directory: string;
  errorStream: Writable;
};

const DEFAULT_LOG_DIR = "var/logs";
const DEFAULT_MAX_FILE_SIZE_MB = 50;
const DEFAULT_RETENTION_DAYS = 14;
const HOSTNAME = sanitizeFileName(os.hostname() || "localhost");
const PID = process.pid;

export function getLogFileConfig(): LogFileConfig {
  return {
    directory: resolveLogDirectory(process.env.LOG_DIR),
    enabled: parseBoolean(process.env.LOG_TO_FILE, true),
    includePid: parseBoolean(process.env.LOG_FILE_INCLUDE_PID, false),
    maxFileSizeBytes:
      parseBoundedNumber(
        process.env.LOG_MAX_FILE_SIZE_MB,
        DEFAULT_MAX_FILE_SIZE_MB,
        1,
        1024,
      ) *
      1024 *
      1024,
    required: parseBoolean(process.env.LOG_FILE_REQUIRED, true),
    retentionDays: parseBoundedNumber(
      process.env.LOG_RETENTION_DAYS,
      DEFAULT_RETENTION_DAYS,
      1,
      3650,
    ),
    stdout: parseBoolean(process.env.LOG_STDOUT, true),
  };
}

export function createLogFileDestinations(
  config = getLogFileConfig(),
): LogFileDestinations | null {
  if (!config.enabled) {
    return null;
  }

  try {
    fs.mkdirSync(/* turbopackIgnore: true */ config.directory, {
      recursive: true,
    });
    fs.accessSync(
      /* turbopackIgnore: true */ config.directory,
      fs.constants.W_OK,
    );
    cleanupExpiredLogs(
      /* turbopackIgnore: true */ config.directory,
      config.retentionDays,
    );

    return {
      appStream: new RotatingLogFileStream({
        directory: config.directory,
        includePid: config.includePid,
        maxFileSizeBytes: config.maxFileSizeBytes,
        prefix: "app",
      }),
      directory: config.directory,
      errorStream: new RotatingLogFileStream({
        directory: config.directory,
        includePid: config.includePid,
        maxFileSizeBytes: config.maxFileSizeBytes,
        prefix: "error",
      }),
    };
  } catch (error) {
    const message = formatSetupError(config.directory, error);
    if (config.required) {
      throw new Error(message, { cause: error });
    }

    process.stderr.write(`${message}\n`);
    return null;
  }
}

class RotatingLogFileStream extends Writable {
  private currentDate = "";
  private currentFilePath = "";
  private currentSizeBytes = 0;
  private sequence = 0;
  private stream: fs.WriteStream | null = null;

  constructor(private readonly options: RotatingLogFileStreamOptions) {
    super();
    this.openStream();
  }

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    try {
      const chunkSizeBytes = Buffer.isBuffer(chunk)
        ? chunk.length
        : Buffer.byteLength(chunk, encoding);
      this.rotateIfNeeded(chunkSizeBytes);

      const stream = this.stream;
      if (!stream) {
        callback(new Error("Log file stream is not initialized."));
        return;
      }

      const done = (error?: Error | null) => {
        if (!error) {
          this.currentSizeBytes += chunkSizeBytes;
        }
        callback(error);
      };

      if (stream.write(chunk, encoding, done)) {
        return;
      }
    } catch (error) {
      callback(error instanceof Error ? error : new Error(String(error)));
    }
  }

  override _final(callback: (error?: Error | null) => void) {
    if (!this.stream) {
      callback();
      return;
    }

    this.stream.end(callback);
  }

  private rotateIfNeeded(nextChunkSizeBytes: number) {
    const date = getLocalDateKey();
    const shouldRotateDate = this.currentDate !== date;
    const shouldRotateSize =
      this.currentSizeBytes > 0 &&
      this.currentSizeBytes + nextChunkSizeBytes > this.options.maxFileSizeBytes;

    if (!shouldRotateDate && !shouldRotateSize) {
      return;
    }

    if (shouldRotateDate) {
      this.currentDate = date;
      this.sequence = 0;
    } else {
      this.sequence += 1;
    }

    this.openStream();
  }

  private openStream() {
    this.stream?.end();

    if (!this.currentDate) {
      this.currentDate = getLocalDateKey();
    }

    this.currentFilePath = getLogFilePath({
      date: this.currentDate,
      directory: this.options.directory,
      includePid: this.options.includePid,
      prefix: this.options.prefix,
      sequence: this.sequence,
    });
    this.currentSizeBytes = getExistingFileSize(this.currentFilePath);
    ensureFileExists(this.currentFilePath);
    this.stream = fs.createWriteStream(this.currentFilePath, { flags: "a" });
  }
}

function cleanupExpiredLogs(directory: string, retentionDays: number) {
  const expiresBefore = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

  for (const entry of fs.readdirSync(/* turbopackIgnore: true */ directory, {
    withFileTypes: true,
  })) {
    if (!entry.isFile() || !isManagedLogFile(entry.name)) {
      continue;
    }

    const filePath = path.join(
      /* turbopackIgnore: true */ directory,
      entry.name,
    );
    const stats = fs.statSync(/* turbopackIgnore: true */ filePath);
    if (stats.mtimeMs < expiresBefore) {
      fs.rmSync(/* turbopackIgnore: true */ filePath, { force: true });
    }
  }
}

function ensureFileExists(filePath: string) {
  const fileDescriptor = fs.openSync(/* turbopackIgnore: true */ filePath, "a");
  fs.closeSync(fileDescriptor);
}

function getExistingFileSize(filePath: string) {
  try {
    return fs.statSync(/* turbopackIgnore: true */ filePath).size;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return 0;
    }

    throw error;
  }
}

function getLogFilePath({
  date,
  directory,
  includePid,
  prefix,
  sequence,
}: {
  date: string;
  directory: string;
  includePid: boolean;
  prefix: "app" | "error";
  sequence: number;
}) {
  const suffix = sequence > 0 ? `-${sequence}` : "";
  const processScope = includePid ? `-${HOSTNAME}-${PID}` : "";
  return path.join(
    /* turbopackIgnore: true */ directory,
    `${prefix}-${date}${processScope}${suffix}.log`,
  );
}

function getLocalDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function resolveLogDirectory(configuredDirectory: string | undefined) {
  const directory = configuredDirectory?.trim() || DEFAULT_LOG_DIR;
  return path.isAbsolute(directory)
    ? path.resolve(/* turbopackIgnore: true */ directory)
    : path.resolve(/* turbopackIgnore: true */ process.cwd(), directory);
}

function parseBoolean(value: string | undefined, defaultValue: boolean) {
  const normalizedValue = value?.trim().toLowerCase();
  if (!normalizedValue) {
    return defaultValue;
  }

  if (["1", "true", "yes", "on"].includes(normalizedValue)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalizedValue)) {
    return false;
  }

  return defaultValue;
}

function parseBoundedNumber(
  value: string | undefined,
  defaultValue: number,
  min: number,
  max: number,
) {
  const parsedValue = Number(value);
  if (!Number.isFinite(parsedValue)) {
    return defaultValue;
  }

  return Math.min(Math.max(Math.floor(parsedValue), min), max);
}

function isManagedLogFile(fileName: string) {
  return /^(app|error)-\d{4}-\d{2}-\d{2}(-.+)?\.log$/.test(fileName);
}

function sanitizeFileName(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function formatSetupError(directory: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return `Failed to initialize log file directory ${directory}: ${message}`;
}

function isNodeError(error: unknown, code: string) {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
