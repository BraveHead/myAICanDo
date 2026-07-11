import fs from "node:fs/promises";
import path from "node:path";

export type FilesystemServiceContext = {
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

export type FilesystemServiceError = {
  code: string;
  message: string;
};

export type FilesystemDirectoryEntry = {
  name: string;
  path: string;
  sizeBytes?: number;
  type: FilesystemDirectoryEntryType;
  updatedAt: string;
};

type FilesystemDirectoryEntryType =
  | "directory"
  | "file"
  | "other"
  | "symlink";

export type FilesystemSearchMatch = {
  line: string;
  lineNumber: number;
  path: string;
};

export type ListFilesystemDirectoryResult =
  | {
      entries: FilesystemDirectoryEntry[];
      ok: true;
      path: string;
      summary: string;
      truncated: boolean;
    }
  | FilesystemServiceErrorResult;

export type ReadFilesystemFileResult =
  | {
      content: string;
      ok: true;
      path: string;
      sizeBytes: number;
      summary: string;
    }
  | FilesystemServiceErrorResult;

export type SearchFilesystemTextResult =
  | {
      caseSensitive: boolean;
      matches: FilesystemSearchMatch[];
      ok: true;
      path: string;
      query: string;
      scannedFiles: number;
      skippedFiles: number;
      summary: string;
      truncated: boolean;
    }
  | FilesystemServiceErrorResult;

export type FilesystemServiceErrorResult = {
  error: FilesystemServiceError;
  ok: false;
  summary: string;
};

const MAX_DIRECTORY_ENTRIES = 200;
const MAX_READ_BYTES = 256_000;
const MAX_SEARCH_DEPTH = 6;
const MAX_SEARCH_FILE_BYTES = 128_000;
const MAX_SEARCH_FILES = 200;
export const FILESYSTEM_MAX_SEARCH_RESULTS = 50;

export async function listFilesystemDirectory(
  context: FilesystemServiceContext,
  inputPath = ".",
): Promise<ListFilesystemDirectoryResult> {
  const sandboxRoot = getSandboxRoot(context);
  if (!sandboxRoot) {
    return createMissingContextError();
  }

  const resolvedPath = resolveSandboxPath(sandboxRoot, inputPath);
  if (!resolvedPath.ok) {
    return createInvalidPathError(resolvedPath.error);
  }

  try {
    const stats = await fs.lstat(
      /* turbopackIgnore: true */ resolvedPath.absolutePath,
    );
    if (stats.isSymbolicLink()) {
      return createAccessError("symlink_not_allowed", "Symlinks are not listed.");
    }

    if (!stats.isDirectory()) {
      return createAccessError("not_directory", "The path is not a directory.");
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

    const truncated = allNames.length > MAX_DIRECTORY_ENTRIES;
    return {
      ok: true,
      path: resolvedPath.relativePath,
      entries,
      truncated,
      summary: summarizeDirectoryList(resolvedPath.relativePath, entries, truncated),
    };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return {
        ok: true,
        path: resolvedPath.relativePath,
        entries: [],
        truncated: false,
        summary: `当前沙盒路径 \`${resolvedPath.relativePath}\` 下没有文件或目录。`,
      };
    }

    return createAccessError("list_failed", formatError(error));
  }
}

export async function readFilesystemFile(
  context: FilesystemServiceContext,
  inputPath: string,
): Promise<ReadFilesystemFileResult> {
  const sandboxRoot = getSandboxRoot(context);
  if (!sandboxRoot) {
    return createMissingContextError();
  }

  const resolvedPath = resolveSandboxPath(sandboxRoot, inputPath);
  if (!resolvedPath.ok) {
    return createInvalidPathError(resolvedPath.error);
  }

  try {
    const stats = await fs.lstat(
      /* turbopackIgnore: true */ resolvedPath.absolutePath,
    );
    if (stats.isSymbolicLink()) {
      return createAccessError("symlink_not_allowed", "Symlinks are not readable.");
    }

    if (!stats.isFile()) {
      return createAccessError("not_file", "The path is not a regular file.");
    }

    if (stats.size > MAX_READ_BYTES) {
      return createAccessError(
        "file_too_large",
        `File exceeds the ${MAX_READ_BYTES} byte read limit.`,
      );
    }

    const contentBuffer = await fs.readFile(
      /* turbopackIgnore: true */ resolvedPath.absolutePath,
    );
    if (looksBinary(contentBuffer)) {
      return createAccessError("binary_file", "Binary files are not readable.");
    }

    const content = decodeUtf8(contentBuffer);
    return {
      ok: true,
      path: resolvedPath.relativePath,
      sizeBytes: stats.size,
      content,
      summary: `已读取文件 \`${resolvedPath.relativePath}\`，大小 ${stats.size} bytes。`,
    };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return createAccessError("file_not_found", "File not found.");
    }

    return createAccessError("read_failed", formatError(error));
  }
}

export async function searchFilesystemText(
  context: FilesystemServiceContext,
  {
    caseSensitive = false,
    maxResults = FILESYSTEM_MAX_SEARCH_RESULTS,
    path: inputPath = ".",
    query,
  }: {
    caseSensitive?: boolean;
    maxResults?: number;
    path?: string;
    query: string;
  },
): Promise<SearchFilesystemTextResult> {
  const sandboxRoot = getSandboxRoot(context);
  if (!sandboxRoot) {
    return createMissingContextError();
  }

  const resolvedPath = resolveSandboxPath(sandboxRoot, inputPath);
  if (!resolvedPath.ok) {
    return createInvalidPathError(resolvedPath.error);
  }

  const state = {
    matches: [] as FilesystemSearchMatch[],
    scannedFiles: 0,
    skippedFiles: 0,
  };
  const boundedMaxResults = Math.min(maxResults, FILESYSTEM_MAX_SEARCH_RESULTS);

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

    const truncated =
      state.matches.length >= boundedMaxResults ||
      state.scannedFiles >= MAX_SEARCH_FILES;
    return {
      ok: true,
      path: resolvedPath.relativePath,
      query,
      caseSensitive,
      matches: state.matches,
      scannedFiles: state.scannedFiles,
      skippedFiles: state.skippedFiles,
      truncated,
      summary: summarizeSearchResult(
        resolvedPath.relativePath,
        query,
        state.matches.length,
        truncated,
      ),
    };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return {
        ok: true,
        path: resolvedPath.relativePath,
        query,
        caseSensitive,
        matches: [],
        scannedFiles: 0,
        skippedFiles: 0,
        truncated: false,
        summary: `路径 \`${resolvedPath.relativePath}\` 不存在，没有找到匹配“${query}”的内容。`,
      };
    }

    return createAccessError("search_failed", formatError(error));
  }
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
    matches: FilesystemSearchMatch[];
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

function getSandboxRoot(context: FilesystemServiceContext) {
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

function summarizeDirectoryList(
  targetPath: string,
  entries: FilesystemDirectoryEntry[],
  truncated: boolean,
) {
  if (entries.length === 0) {
    return `当前沙盒路径 \`${targetPath}\` 下没有文件或目录。`;
  }

  const entryLines = entries.map((entry) => {
    const size = entry.sizeBytes === undefined ? "" : `, ${entry.sizeBytes} bytes`;
    return `- ${entry.path} (${entry.type}${size})`;
  });
  return [
    `当前沙盒路径 \`${targetPath}\` 下有：`,
    ...entryLines,
    ...(truncated ? ["结果已截断。"] : []),
  ].join("\n");
}

function summarizeSearchResult(
  targetPath: string,
  query: string,
  matchCount: number,
  truncated: boolean,
) {
  const prefix =
    matchCount === 0
      ? `路径 \`${targetPath}\` 下没有找到匹配“${query}”的内容。`
      : `路径 \`${targetPath}\` 下找到 ${matchCount} 条匹配“${query}”的结果。`;
  return truncated ? `${prefix} 结果已截断。` : prefix;
}

function sanitizePathSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128) || "unknown";
}

function joinRelativePath(parentPath: string, name: string) {
  return parentPath === "." ? name : `${parentPath}/${name}`;
}

function getStatsType(
  stats: Awaited<ReturnType<typeof fs.lstat>>,
): FilesystemDirectoryEntryType {
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

function createAccessError(
  code: string,
  message: string,
): FilesystemServiceErrorResult {
  return {
    ok: false,
    summary: `Filesystem error: ${code}, ${message}`,
    error: {
      code,
      message,
    },
  };
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
