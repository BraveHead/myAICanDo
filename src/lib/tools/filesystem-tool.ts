import fs from "node:fs/promises";
import path from "node:path";
import { tool } from "langchain";
import * as z from "zod";

type FilesystemToolContext = {
  threadId?: string;
  threadScope?: {
    tenantHashId: string;
    userHashId: string;
  };
};

type ResolvedSandboxPath =
  | {
      absolutePath: string;
      ok: true;
      relativePath: string;
    }
  | {
      error: string;
      ok: false;
    };

const MAX_DIRECTORY_ENTRIES = 200;
const MAX_READ_BYTES = 256_000;
const MAX_SEARCH_DEPTH = 6;
const MAX_SEARCH_FILE_BYTES = 128_000;
const MAX_SEARCH_FILES = 200;
const MAX_SEARCH_RESULTS = 50;

const relativePathSchema = z
  .string()
  .optional()
  .describe("Relative path inside the current thread sandbox. Defaults to '.'.");

export function createFilesystemTools(context: FilesystemToolContext) {
  const sandboxRoot = getSandboxRoot(context);

  return [
    tool(
      async ({ path: inputPath = "." }) => {
        if (!sandboxRoot) {
          return jsonResult(createMissingContextError());
        }

        const resolvedPath = resolveSandboxPath(sandboxRoot, inputPath);
        if (!resolvedPath.ok) {
          return jsonResult(createInvalidPathError(resolvedPath.error));
        }

        try {
          const stats = await fs.lstat(
            /* turbopackIgnore: true */ resolvedPath.absolutePath,
          );
          if (stats.isSymbolicLink()) {
            return jsonResult(
              createAccessError("symlink_not_allowed", "Symlinks are not listed."),
            );
          }

          if (!stats.isDirectory()) {
            return jsonResult(
              createAccessError("not_directory", "The path is not a directory."),
            );
          }

          const allNames = (await fs.readdir(
            /* turbopackIgnore: true */ resolvedPath.absolutePath,
          )).sort((left, right) => left.localeCompare(right));
          const names = allNames.slice(0, MAX_DIRECTORY_ENTRIES);
          const entries = await Promise.all(
            names.map(async (name) => {
              const entryAbsolutePath = path.join(
                /* turbopackIgnore: true */ resolvedPath.absolutePath,
                name,
              );
              const entryStats = await fs.lstat(
                /* turbopackIgnore: true */ entryAbsolutePath,
              );

              return {
                name,
                path: joinRelativePath(resolvedPath.relativePath, name),
                sizeBytes: entryStats.isFile() ? entryStats.size : undefined,
                type: getStatsType(entryStats),
                updatedAt: entryStats.mtime.toISOString(),
              };
            }),
          );

          return jsonResult({
            ok: true,
            path: resolvedPath.relativePath,
            entries,
            truncated: allNames.length > MAX_DIRECTORY_ENTRIES,
          });
        } catch (error) {
          if (isNodeError(error, "ENOENT")) {
            return jsonResult({
              ok: true,
              path: resolvedPath.relativePath,
              entries: [],
              truncated: false,
            });
          }

          return jsonResult(createAccessError("list_failed", formatError(error)));
        }
      },
      {
        name: "list_filesystem_directory",
        description:
          "List files and directories inside the current thread sandbox. Accepts only relative paths. Use this for directory entries; do not read directories as files.",
        schema: z.object({
          path: relativePathSchema,
        }),
      },
    ),
    tool(
      async ({ path: inputPath }) => {
        if (!sandboxRoot) {
          return jsonResult(createMissingContextError());
        }

        const resolvedPath = resolveSandboxPath(sandboxRoot, inputPath);
        if (!resolvedPath.ok) {
          return jsonResult(createInvalidPathError(resolvedPath.error));
        }

        try {
          const stats = await fs.lstat(
            /* turbopackIgnore: true */ resolvedPath.absolutePath,
          );
          if (stats.isSymbolicLink()) {
            return jsonResult(
              createAccessError("symlink_not_allowed", "Symlinks are not readable."),
            );
          }

          if (!stats.isFile()) {
            return jsonResult(
              createAccessError("not_file", "The path is not a regular file."),
            );
          }

          if (stats.size > MAX_READ_BYTES) {
            return jsonResult(
              createAccessError(
                "file_too_large",
                `File exceeds the ${MAX_READ_BYTES} byte read limit.`,
              ),
            );
          }

          const contentBuffer = await fs.readFile(
            /* turbopackIgnore: true */ resolvedPath.absolutePath,
          );
          if (looksBinary(contentBuffer)) {
            return jsonResult(
              createAccessError("binary_file", "Binary files are not readable."),
            );
          }

          const content = decodeUtf8(contentBuffer);
          return jsonResult({
            ok: true,
            path: resolvedPath.relativePath,
            sizeBytes: stats.size,
            content,
          });
        } catch (error) {
          if (isNodeError(error, "ENOENT")) {
            return jsonResult(createAccessError("file_not_found", "File not found."));
          }

          return jsonResult(createAccessError("read_failed", formatError(error)));
        }
      },
      {
        name: "read_filesystem_file",
        description:
          "Read a UTF-8 text file inside the current thread sandbox. Accepts only relative paths. Only call this for paths listed with type 'file', never for directories.",
        schema: z.object({
          path: z
            .string()
            .min(1)
            .describe("Relative file path inside the current thread sandbox."),
        }),
      },
    ),
    tool(
      async ({
        caseSensitive = false,
        maxResults = MAX_SEARCH_RESULTS,
        path: inputPath = ".",
        query,
      }) => {
        if (!sandboxRoot) {
          return jsonResult(createMissingContextError());
        }

        const resolvedPath = resolveSandboxPath(sandboxRoot, inputPath);
        if (!resolvedPath.ok) {
          return jsonResult(createInvalidPathError(resolvedPath.error));
        }

        const state = {
          matches: [] as Array<{
            line: string;
            lineNumber: number;
            path: string;
          }>,
          scannedFiles: 0,
          skippedFiles: 0,
        };
        const boundedMaxResults = Math.min(maxResults, MAX_SEARCH_RESULTS);

        try {
          await searchSandboxPath({
            absolutePath: resolvedPath.absolutePath,
            caseSensitive,
            depth: 0,
            displayPath: resolvedPath.relativePath,
            maxResults: boundedMaxResults,
            query,
            state,
          });

          return jsonResult({
            ok: true,
            path: resolvedPath.relativePath,
            query,
            caseSensitive,
            matches: state.matches,
            scannedFiles: state.scannedFiles,
            skippedFiles: state.skippedFiles,
            truncated:
              state.matches.length >= boundedMaxResults ||
              state.scannedFiles >= MAX_SEARCH_FILES,
          });
        } catch (error) {
          if (isNodeError(error, "ENOENT")) {
            return jsonResult({
              ok: true,
              path: resolvedPath.relativePath,
              query,
              caseSensitive,
              matches: [],
              scannedFiles: 0,
              skippedFiles: 0,
              truncated: false,
            });
          }

          return jsonResult(createAccessError("search_failed", formatError(error)));
        }
      },
      {
        name: "search_filesystem_text",
        description:
          "Search UTF-8 text files inside the current thread sandbox. Accepts only relative paths.",
        schema: z.object({
          query: z.string().min(1).max(200).describe("Text to search for."),
          path: relativePathSchema,
          caseSensitive: z
            .boolean()
            .optional()
            .describe("Whether substring matching should be case-sensitive."),
          maxResults: z
            .number()
            .int()
            .min(1)
            .max(MAX_SEARCH_RESULTS)
            .optional()
            .describe("Maximum number of matches to return."),
        }),
      },
    ),
  ];
}

async function searchSandboxPath({
  absolutePath,
  caseSensitive,
  depth,
  displayPath,
  maxResults,
  query,
  state,
}: {
  absolutePath: string;
  caseSensitive: boolean;
  depth: number;
  displayPath: string;
  maxResults: number;
  query: string;
  state: {
    matches: Array<{
      line: string;
      lineNumber: number;
      path: string;
    }>;
    scannedFiles: number;
    skippedFiles: number;
  };
}) {
  if (
    state.matches.length >= maxResults ||
    state.scannedFiles >= MAX_SEARCH_FILES
  ) {
    return;
  }

  const stats = await fs.lstat(/* turbopackIgnore: true */ absolutePath);
  if (stats.isSymbolicLink()) {
    state.skippedFiles += 1;
    return;
  }

  if (stats.isDirectory()) {
    if (depth >= MAX_SEARCH_DEPTH) {
      state.skippedFiles += 1;
      return;
    }

    const names = (await fs.readdir(/* turbopackIgnore: true */ absolutePath))
      .sort((left, right) => left.localeCompare(right));
    for (const name of names) {
      if (
        state.matches.length >= maxResults ||
        state.scannedFiles >= MAX_SEARCH_FILES
      ) {
        break;
      }

      await searchSandboxPath({
        absolutePath: path.join(
          /* turbopackIgnore: true */ absolutePath,
          name,
        ),
        caseSensitive,
        depth: depth + 1,
        displayPath: joinRelativePath(displayPath, name),
        maxResults,
        query,
        state,
      });
    }
    return;
  }

  if (!stats.isFile()) {
    state.skippedFiles += 1;
    return;
  }

  state.scannedFiles += 1;
  if (stats.size > MAX_SEARCH_FILE_BYTES) {
    state.skippedFiles += 1;
    return;
  }

  const contentBuffer = await fs.readFile(
    /* turbopackIgnore: true */ absolutePath,
  );
  if (looksBinary(contentBuffer)) {
    state.skippedFiles += 1;
    return;
  }

  const lines = decodeUtf8(contentBuffer).split(/\r\n|\r|\n/);
  const needle = caseSensitive ? query : query.toLowerCase();
  lines.forEach((line, index) => {
    if (state.matches.length >= maxResults) {
      return;
    }

    const haystack = caseSensitive ? line : line.toLowerCase();
    if (!haystack.includes(needle)) {
      return;
    }

    state.matches.push({
      path: displayPath,
      lineNumber: index + 1,
      line: line.length > 500 ? `${line.slice(0, 500)}...` : line,
    });
  });
}

function getSandboxRoot(context: FilesystemToolContext) {
  if (!context.threadId || !context.threadScope) {
    return null;
  }

  const configuredRoot = process.env.FILESYSTEM_SANDBOX_ROOT?.trim();
  const root = configuredRoot
    ? path.resolve(/* turbopackIgnore: true */ configuredRoot)
    : path.join(
        /* turbopackIgnore: true */ process.cwd(),
        "var",
        "agent-files",
      );

  return path.join(
    /* turbopackIgnore: true */ root,
    sanitizePathSegment(context.threadScope.tenantHashId),
    sanitizePathSegment(context.threadScope.userHashId),
    sanitizePathSegment(context.threadId),
  );
}

function resolveSandboxPath(
  sandboxRoot: string,
  inputPath: string | undefined,
): ResolvedSandboxPath {
  const rawPath = inputPath?.trim() || ".";
  if (rawPath.includes("\0")) {
    return { ok: false, error: "Path cannot contain null bytes." };
  }

  if (path.isAbsolute(rawPath) || path.win32.isAbsolute(rawPath)) {
    return { ok: false, error: "Path must be relative." };
  }

  const segments = rawPath
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");

  if (segments.some((segment) => segment === "..")) {
    return { ok: false, error: "Path cannot contain '..' segments." };
  }

  const relativePath = segments.join("/") || ".";
  const absolutePath = path.resolve(
    /* turbopackIgnore: true */ sandboxRoot,
    ...segments,
  );
  const relativeFromRoot = path.relative(sandboxRoot, absolutePath);
  if (relativeFromRoot.startsWith("..") || path.isAbsolute(relativeFromRoot)) {
    return { ok: false, error: "Path escapes the sandbox root." };
  }

  return {
    absolutePath,
    ok: true,
    relativePath,
  };
}

function sanitizePathSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128) || "unknown";
}

function joinRelativePath(parentPath: string, name: string) {
  return parentPath === "." ? name : `${parentPath}/${name}`;
}

function getStatsType(stats: Awaited<ReturnType<typeof fs.lstat>>) {
  if (stats.isDirectory()) {
    return "directory";
  }

  if (stats.isFile()) {
    return "file";
  }

  if (stats.isSymbolicLink()) {
    return "symlink";
  }

  return "other";
}

function looksBinary(buffer: Buffer) {
  if (buffer.includes(0)) {
    return true;
  }

  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  if (sample.length === 0) {
    return false;
  }

  let suspiciousBytes = 0;
  for (const byte of sample) {
    const allowedControlByte =
      byte === 9 || byte === 10 || byte === 12 || byte === 13;
    if (byte < 32 && !allowedControlByte) {
      suspiciousBytes += 1;
    }
  }

  return suspiciousBytes / sample.length > 0.3;
}

function decodeUtf8(buffer: Buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error("File is not valid UTF-8 text.");
  }
}

function createMissingContextError() {
  return createAccessError(
    "missing_context",
    "Filesystem tools require tenant, user, and thread context.",
  );
}

function createInvalidPathError(message: string) {
  return createAccessError("invalid_path", message);
}

function createAccessError(code: string, message: string) {
  return {
    ok: false,
    error: {
      code,
      message,
    },
  };
}

function jsonResult(value: unknown) {
  return JSON.stringify(value);
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown, code: string) {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
