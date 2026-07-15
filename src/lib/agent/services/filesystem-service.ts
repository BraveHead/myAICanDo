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

export type FilesystemFileMatch = {
  path: string;
  sizeBytes: number;
  updatedAt: string;
};

export type FilesystemWriteOperation = "create" | "overwrite";

export type FilesystemApprovalPreview =
  | {
      contentPreview: string;
      kind: "write";
      operation: FilesystemWriteOperation;
      path: string;
      previousSizeBytes?: number;
      sizeBytes: number;
      summary: string;
    }
  | {
      after: string;
      before: string;
      kind: "edit";
      newSizeBytes: number;
      path: string;
      replaceAll: boolean;
      replacements: number;
      sizeBytes: number;
      summary: string;
    }
  | {
      contentPreview?: string;
      kind: "delete";
      path: string;
      sizeBytes: number;
      summary: string;
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

export type GlobFilesystemFilesResult =
  | {
      matches: FilesystemFileMatch[];
      ok: true;
      path: string;
      pattern: string;
      scannedFiles: number;
      skippedFiles: number;
      summary: string;
      truncated: boolean;
    }
  | FilesystemServiceErrorResult;

export type PreviewFilesystemWriteResult =
  | {
      ok: true;
      preview: Extract<FilesystemApprovalPreview, { kind: "write" }>;
      summary: string;
    }
  | FilesystemServiceErrorResult;

export type WriteFilesystemFileResult =
  | {
      ok: true;
      operation: FilesystemWriteOperation;
      path: string;
      sizeBytes: number;
      summary: string;
    }
  | FilesystemServiceErrorResult;

export type PreviewFilesystemEditResult =
  | {
      ok: true;
      preview: Extract<FilesystemApprovalPreview, { kind: "edit" }>;
      summary: string;
      updatedContent: string;
    }
  | FilesystemServiceErrorResult;

export type EditFilesystemFileResult =
  | {
      newSizeBytes: number;
      ok: true;
      path: string;
      replacements: number;
      sizeBytes: number;
      summary: string;
    }
  | FilesystemServiceErrorResult;

export type PreviewFilesystemDeleteResult =
  | {
      ok: true;
      preview: Extract<FilesystemApprovalPreview, { kind: "delete" }>;
      summary: string;
    }
  | FilesystemServiceErrorResult;

export type DeleteFilesystemFileResult =
  | {
      ok: true;
      path: string;
      sizeBytes: number;
      summary: string;
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
const MAX_GLOB_DEPTH = 8;
const MAX_GLOB_FILES = 500;
const PREVIEW_TEXT_LIMIT = 1_000;
const MUTABLE_ROOTS = ["workspace", "notes"] as const;
export const FILESYSTEM_MAX_SEARCH_RESULTS = 50;
export const FILESYSTEM_MAX_GLOB_RESULTS = 200;
export const FILESYSTEM_MAX_WRITE_BYTES = 256_000;
export const FILESYSTEM_MAX_EDIT_REPLACEMENTS = 20;

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

export async function globFilesystemFiles(
  context: FilesystemServiceContext,
  {
    maxResults = FILESYSTEM_MAX_GLOB_RESULTS,
    path: inputPath = ".",
    pattern,
  }: {
    maxResults?: number;
    path?: string;
    pattern: string;
  },
): Promise<GlobFilesystemFilesResult> {
  const sandboxRoot = getSandboxRoot(context);
  if (!sandboxRoot) {
    return createMissingContextError();
  }

  const normalizedPattern = normalizeGlobPattern(pattern);
  if (!normalizedPattern.ok) {
    return createAccessError("invalid_glob", normalizedPattern.error);
  }

  const resolvedPath = resolveSandboxPath(sandboxRoot, inputPath);
  if (!resolvedPath.ok) {
    return createInvalidPathError(resolvedPath.error);
  }

  const boundedMaxResults = Math.min(maxResults, FILESYSTEM_MAX_GLOB_RESULTS);
  const matcher = createGlobMatcher(normalizedPattern.pattern);
  const state = {
    matches: [] as FilesystemFileMatch[],
    scannedFiles: 0,
    skippedFiles: 0,
  };

  try {
    await globSandboxPath({
      absolutePath: resolvedPath.absolutePath,
      depth: 0,
      displayPath: resolvedPath.relativePath,
      matcher,
      maxResults: boundedMaxResults,
      relativeMatchPath: "",
      state,
    });

    const truncated =
      state.matches.length >= boundedMaxResults ||
      state.scannedFiles >= MAX_GLOB_FILES;
    return {
      ok: true,
      path: resolvedPath.relativePath,
      pattern: normalizedPattern.pattern,
      matches: state.matches,
      scannedFiles: state.scannedFiles,
      skippedFiles: state.skippedFiles,
      truncated,
      summary: summarizeGlobResult(
        resolvedPath.relativePath,
        normalizedPattern.pattern,
        state.matches.length,
        truncated,
      ),
    };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return {
        ok: true,
        path: resolvedPath.relativePath,
        pattern: normalizedPattern.pattern,
        matches: [],
        scannedFiles: 0,
        skippedFiles: 0,
        truncated: false,
        summary: `路径 \`${resolvedPath.relativePath}\` 不存在，没有找到匹配 \`${normalizedPattern.pattern}\` 的文件。`,
      };
    }

    return createAccessError("glob_failed", formatError(error));
  }
}

export async function previewFilesystemWrite(
  context: FilesystemServiceContext,
  {
    content,
    path: inputPath,
  }: {
    content: string;
    path: string;
  },
): Promise<PreviewFilesystemWriteResult> {
  const preparedPath = prepareMutablePath(context, inputPath);
  if (!preparedPath.ok) {
    return preparedPath;
  }

  const sizeBytes = Buffer.byteLength(content, "utf8");
  if (sizeBytes > FILESYSTEM_MAX_WRITE_BYTES) {
    return createAccessError(
      "file_too_large",
      `File exceeds the ${FILESYSTEM_MAX_WRITE_BYTES} byte write limit.`,
    );
  }

  const parentError = await validateExistingParentChain(preparedPath);
  if (parentError) {
    return parentError;
  }

  try {
    const stats = await fs.lstat(
      /* turbopackIgnore: true */ preparedPath.absolutePath,
    );
    if (stats.isSymbolicLink()) {
      return createAccessError("symlink_not_allowed", "Symlinks are not writable.");
    }

    if (!stats.isFile()) {
      return createAccessError("not_file", "The path is not a regular file.");
    }

    const summary = `需要确认后覆盖文件 \`${preparedPath.relativePath}\`，新大小 ${sizeBytes} bytes。`;
    return {
      ok: true,
      summary,
      preview: {
        kind: "write",
        path: preparedPath.relativePath,
        operation: "overwrite",
        previousSizeBytes: stats.size,
        sizeBytes,
        contentPreview: truncatePreviewText(content),
        summary,
      },
    };
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) {
      return createAccessError("write_preview_failed", formatError(error));
    }
  }

  const summary = `需要确认后创建文件 \`${preparedPath.relativePath}\`，大小 ${sizeBytes} bytes。`;
  return {
    ok: true,
    summary,
    preview: {
      kind: "write",
      path: preparedPath.relativePath,
      operation: "create",
      sizeBytes,
      contentPreview: truncatePreviewText(content),
      summary,
    },
  };
}

export async function writeFilesystemFile(
  context: FilesystemServiceContext,
  input: {
    content: string;
    path: string;
  },
): Promise<WriteFilesystemFileResult> {
  const preview = await previewFilesystemWrite(context, input);
  if (!preview.ok) {
    return preview;
  }

  const preparedPath = prepareMutablePath(context, input.path);
  if (!preparedPath.ok) {
    return preparedPath;
  }

  try {
    await fs.mkdir(
      /* turbopackIgnore: true */ path.dirname(preparedPath.absolutePath),
      {
        recursive: true,
      },
    );

    const parentError = await validateExistingParentChain(preparedPath);
    if (parentError) {
      return parentError;
    }

    const targetError = await validateWritableTarget(preparedPath);
    if (targetError) {
      return targetError;
    }

    await fs.writeFile(
      /* turbopackIgnore: true */ preparedPath.absolutePath,
      input.content,
      "utf8",
    );

    return {
      ok: true,
      path: preparedPath.relativePath,
      operation: preview.preview.operation,
      sizeBytes: preview.preview.sizeBytes,
      summary: summarizeWriteResult(
        preparedPath.relativePath,
        preview.preview.operation,
        preview.preview.sizeBytes,
      ),
    };
  } catch (error) {
    return createAccessError("write_failed", formatError(error));
  }
}

export async function previewFilesystemEdit(
  context: FilesystemServiceContext,
  {
    newText,
    oldText,
    path: inputPath,
    replaceAll = false,
  }: {
    newText: string;
    oldText: string;
    path: string;
    replaceAll?: boolean;
  },
): Promise<PreviewFilesystemEditResult> {
  if (!oldText) {
    return createAccessError("invalid_edit", "oldText must be a non-empty string.");
  }

  const target = await readMutableTextFile(context, inputPath, "editable");
  if (!target.ok) {
    return target;
  }

  const replacements = countOccurrences(target.content, oldText);
  if (replacements === 0) {
    return createAccessError("text_not_found", "oldText was not found in the file.");
  }

  if (!replaceAll && replacements > 1) {
    return createAccessError(
      "ambiguous_match",
      "oldText appears more than once. Set replaceAll to true to replace every occurrence.",
    );
  }

  if (replaceAll && replacements > FILESYSTEM_MAX_EDIT_REPLACEMENTS) {
    return createAccessError(
      "too_many_replacements",
      `edit_file can replace at most ${FILESYSTEM_MAX_EDIT_REPLACEMENTS} occurrences at once.`,
    );
  }

  const firstIndex = target.content.indexOf(oldText);
  const updatedContent = replaceAll
    ? target.content.split(oldText).join(newText)
    : replaceFirst(target.content, oldText, newText);
  const newSizeBytes = Buffer.byteLength(updatedContent, "utf8");
  if (newSizeBytes > FILESYSTEM_MAX_WRITE_BYTES) {
    return createAccessError(
      "file_too_large",
      `Edited file exceeds the ${FILESYSTEM_MAX_WRITE_BYTES} byte write limit.`,
    );
  }

  const summary = `需要确认后编辑文件 \`${target.relativePath}\`，替换 ${replaceAll ? replacements : 1} 处文本。`;
  return {
    ok: true,
    summary,
    updatedContent,
    preview: {
      kind: "edit",
      path: target.relativePath,
      replacements: replaceAll ? replacements : 1,
      replaceAll,
      sizeBytes: target.sizeBytes,
      newSizeBytes,
      before: createPreviewSnippet(target.content, firstIndex, oldText.length),
      after: createPreviewSnippet(updatedContent, firstIndex, newText.length),
      summary,
    },
  };
}

export async function editFilesystemFile(
  context: FilesystemServiceContext,
  input: {
    newText: string;
    oldText: string;
    path: string;
    replaceAll?: boolean;
  },
): Promise<EditFilesystemFileResult> {
  const preview = await previewFilesystemEdit(context, input);
  if (!preview.ok) {
    return preview;
  }

  const preparedPath = prepareMutablePath(context, input.path);
  if (!preparedPath.ok) {
    return preparedPath;
  }

  try {
    await fs.writeFile(
      /* turbopackIgnore: true */ preparedPath.absolutePath,
      preview.updatedContent,
      "utf8",
    );

    return {
      ok: true,
      path: preparedPath.relativePath,
      replacements: preview.preview.replacements,
      sizeBytes: preview.preview.sizeBytes,
      newSizeBytes: preview.preview.newSizeBytes,
      summary: summarizeEditResult(
        preparedPath.relativePath,
        preview.preview.replacements,
      ),
    };
  } catch (error) {
    return createAccessError("edit_failed", formatError(error));
  }
}

export async function previewFilesystemDelete(
  context: FilesystemServiceContext,
  {
    path: inputPath,
  }: {
    path: string;
  },
): Promise<PreviewFilesystemDeleteResult> {
  const preparedPath = prepareMutablePath(context, inputPath);
  if (!preparedPath.ok) {
    return preparedPath;
  }

  const parentError = await validateExistingParentChain(preparedPath);
  if (parentError) {
    return parentError;
  }

  try {
    const stats = await fs.lstat(
      /* turbopackIgnore: true */ preparedPath.absolutePath,
    );
    if (stats.isSymbolicLink()) {
      return createAccessError("symlink_not_allowed", "Symlinks are not deletable.");
    }

    if (!stats.isFile()) {
      return createAccessError("not_file", "Only regular files can be deleted.");
    }

    const contentPreview = await readOptionalTextPreview(
      preparedPath.absolutePath,
      stats.size,
    );
    const summary = `需要确认后删除文件 \`${preparedPath.relativePath}\`，大小 ${stats.size} bytes。`;
    return {
      ok: true,
      summary,
      preview: {
        kind: "delete",
        path: preparedPath.relativePath,
        sizeBytes: stats.size,
        ...(contentPreview ? { contentPreview } : {}),
        summary,
      },
    };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return createAccessError("file_not_found", "File not found.");
    }

    return createAccessError("delete_preview_failed", formatError(error));
  }
}

export async function deleteFilesystemFile(
  context: FilesystemServiceContext,
  input: {
    path: string;
  },
): Promise<DeleteFilesystemFileResult> {
  const preview = await previewFilesystemDelete(context, input);
  if (!preview.ok) {
    return preview;
  }

  const preparedPath = prepareMutablePath(context, input.path);
  if (!preparedPath.ok) {
    return preparedPath;
  }

  try {
    await fs.unlink(/* turbopackIgnore: true */ preparedPath.absolutePath);
    return {
      ok: true,
      path: preparedPath.relativePath,
      sizeBytes: preview.preview.sizeBytes,
      summary: summarizeDeleteResult(
        preparedPath.relativePath,
        preview.preview.sizeBytes,
      ),
    };
  } catch (error) {
    return createAccessError("delete_failed", formatError(error));
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

async function globSandboxPath({
  absolutePath,
  depth,
  displayPath,
  matcher,
  maxResults,
  relativeMatchPath,
  state,
}: {
  absolutePath: string;
  depth: number;
  displayPath: string;
  matcher: (relativePath: string) => boolean;
  maxResults: number;
  relativeMatchPath: string;
  state: {
    matches: FilesystemFileMatch[];
    scannedFiles: number;
    skippedFiles: number;
  };
}) {
  if (
    state.matches.length >= maxResults ||
    state.scannedFiles >= MAX_GLOB_FILES
  ) {
    return;
  }

  const stats = await fs.lstat(/* turbopackIgnore: true */ absolutePath);
  if (stats.isSymbolicLink()) {
    state.skippedFiles += 1;
    return;
  }

  if (stats.isDirectory()) {
    if (depth >= MAX_GLOB_DEPTH) {
      state.skippedFiles += 1;
      return;
    }

    const names = (await fs.readdir(/* turbopackIgnore: true */ absolutePath))
      .sort((left, right) => left.localeCompare(right));
    for (const name of names) {
      if (
        state.matches.length >= maxResults ||
        state.scannedFiles >= MAX_GLOB_FILES
      ) {
        break;
      }

      await globSandboxPath({
        absolutePath: path.join(
          /* turbopackIgnore: true */ absolutePath,
          name,
        ),
        depth: depth + 1,
        displayPath: joinRelativePath(displayPath, name),
        matcher,
        maxResults,
        relativeMatchPath: joinGlobPath(relativeMatchPath, name),
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
  const matchPath = relativeMatchPath || path.basename(displayPath);
  if (!matcher(matchPath)) {
    return;
  }

  state.matches.push({
    path: displayPath,
    sizeBytes: stats.size,
    updatedAt: stats.mtime.toISOString(),
  });
}

type PreparedMutablePath =
  | {
      absolutePath: string;
      ok: true;
      relativePath: string;
      sandboxRoot: string;
    }
  | FilesystemServiceErrorResult;

type MutableTextFile =
  | {
      absolutePath: string;
      content: string;
      ok: true;
      relativePath: string;
      sizeBytes: number;
    }
  | FilesystemServiceErrorResult;

function prepareMutablePath(
  context: FilesystemServiceContext,
  inputPath: string,
): PreparedMutablePath {
  const sandboxRoot = getSandboxRoot(context);
  if (!sandboxRoot) {
    return createMissingContextError();
  }

  const resolvedPath = resolveSandboxPath(sandboxRoot, inputPath);
  if (!resolvedPath.ok) {
    return createInvalidPathError(resolvedPath.error);
  }

  const permissionError = evaluateMutationPermission(resolvedPath.relativePath);
  if (permissionError) {
    return permissionError;
  }

  return {
    absolutePath: resolvedPath.absolutePath,
    ok: true,
    relativePath: resolvedPath.relativePath,
    sandboxRoot,
  };
}

function evaluateMutationPermission(relativePath: string) {
  const segments = relativePath === "." ? [] : relativePath.split("/");
  if (
    segments.length < 2 ||
    !MUTABLE_ROOTS.some((root) => root === segments[0])
  ) {
    return createAccessError(
      "permission_denied",
      "Filesystem mutations are only allowed under workspace/** and notes/**.",
    );
  }

  if (segments.some(isEnvPathSegment)) {
    return createAccessError(
      "permission_denied",
      ".env files are not writable through filesystem tools.",
    );
  }

  return null;
}

async function validateExistingParentChain({
  relativePath,
  sandboxRoot,
}: Extract<PreparedMutablePath, { ok: true }>) {
  const segments = relativePath.split("/");
  let currentPath = sandboxRoot;
  for (const segment of segments.slice(0, -1)) {
    currentPath = path.join(/* turbopackIgnore: true */ currentPath, segment);

    try {
      const stats = await fs.lstat(/* turbopackIgnore: true */ currentPath);
      if (stats.isSymbolicLink()) {
        return createAccessError(
          "symlink_not_allowed",
          "Symlinks are not allowed in writable parent directories.",
        );
      }

      if (!stats.isDirectory()) {
        return createAccessError(
          "parent_not_directory",
          "An existing parent path is not a directory.",
        );
      }
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return null;
      }

      return createAccessError("parent_check_failed", formatError(error));
    }
  }

  return null;
}

async function validateWritableTarget({
  absolutePath,
}: Extract<PreparedMutablePath, { ok: true }>) {
  try {
    const stats = await fs.lstat(/* turbopackIgnore: true */ absolutePath);
    if (stats.isSymbolicLink()) {
      return createAccessError("symlink_not_allowed", "Symlinks are not writable.");
    }

    if (!stats.isFile()) {
      return createAccessError("not_file", "The path is not a regular file.");
    }
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return null;
    }

    return createAccessError("target_check_failed", formatError(error));
  }

  return null;
}

async function readMutableTextFile(
  context: FilesystemServiceContext,
  inputPath: string,
  adjective: string,
): Promise<MutableTextFile> {
  const preparedPath = prepareMutablePath(context, inputPath);
  if (!preparedPath.ok) {
    return preparedPath;
  }

  const parentError = await validateExistingParentChain(preparedPath);
  if (parentError) {
    return parentError;
  }

  try {
    const stats = await fs.lstat(
      /* turbopackIgnore: true */ preparedPath.absolutePath,
    );
    if (stats.isSymbolicLink()) {
      return createAccessError(
        "symlink_not_allowed",
        `Symlinks are not ${adjective}.`,
      );
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
      /* turbopackIgnore: true */ preparedPath.absolutePath,
    );
    if (looksBinary(contentBuffer)) {
      return createAccessError("binary_file", "Binary files are not editable.");
    }

    return {
      absolutePath: preparedPath.absolutePath,
      content: decodeUtf8(contentBuffer),
      ok: true,
      relativePath: preparedPath.relativePath,
      sizeBytes: stats.size,
    };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return createAccessError("file_not_found", "File not found.");
    }

    return createAccessError("read_failed", formatError(error));
  }
}

async function readOptionalTextPreview(absolutePath: string, sizeBytes: number) {
  if (sizeBytes > PREVIEW_TEXT_LIMIT) {
    return undefined;
  }

  try {
    const contentBuffer = await fs.readFile(/* turbopackIgnore: true */ absolutePath);
    if (looksBinary(contentBuffer)) {
      return undefined;
    }

    return truncatePreviewText(decodeUtf8(contentBuffer));
  } catch {
    return undefined;
  }
}

function normalizeGlobPattern(
  rawPattern: string,
):
  | {
      ok: true;
      pattern: string;
    }
  | {
      error: string;
      ok: false;
    } {
  const pattern = rawPattern.trim();
  if (!pattern) {
    return { ok: false, error: "Glob pattern cannot be empty." };
  }

  if (pattern.includes("\0")) {
    return { ok: false, error: "Glob pattern cannot contain null bytes." };
  }

  if (path.isAbsolute(pattern) || path.win32.isAbsolute(pattern)) {
    return { ok: false, error: "Glob pattern must be relative." };
  }

  const segments = pattern
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== ".");

  if (segments.some((segment) => segment === "..")) {
    return { ok: false, error: "Glob pattern cannot contain '..' segments." };
  }

  return {
    ok: true,
    pattern: segments.join("/") || "**",
  };
}

function createGlobMatcher(pattern: string) {
  const patternSegments = pattern.split("/").filter(Boolean);
  return (relativePath: string) => {
    const pathSegments = relativePath.split("/").filter(Boolean);
    const memo = new Map<string, boolean>();
    return matchGlobSegments(patternSegments, pathSegments, 0, 0, memo);
  };
}

function matchGlobSegments(
  patternSegments: string[],
  pathSegments: string[],
  patternIndex: number,
  pathIndex: number,
  memo: Map<string, boolean>,
): boolean {
  const memoKey = `${patternIndex}:${pathIndex}`;
  const memoValue = memo.get(memoKey);
  if (memoValue !== undefined) {
    return memoValue;
  }

  if (patternIndex === patternSegments.length) {
    const result = pathIndex === pathSegments.length;
    memo.set(memoKey, result);
    return result;
  }

  const segment = patternSegments[patternIndex];
  if (segment === "**") {
    for (let index = pathIndex; index <= pathSegments.length; index += 1) {
      if (
        matchGlobSegments(
          patternSegments,
          pathSegments,
          patternIndex + 1,
          index,
          memo,
        )
      ) {
        memo.set(memoKey, true);
        return true;
      }
    }

    memo.set(memoKey, false);
    return false;
  }

  if (pathIndex >= pathSegments.length) {
    memo.set(memoKey, false);
    return false;
  }

  const result =
    matchGlobSegment(segment, pathSegments[pathIndex]) &&
    matchGlobSegments(
      patternSegments,
      pathSegments,
      patternIndex + 1,
      pathIndex + 1,
      memo,
    );
  memo.set(memoKey, result);
  return result;
}

function matchGlobSegment(patternSegment: string, pathSegment: string) {
  const regex = new RegExp(
    `^${patternSegment
      .split("")
      .map((character) => {
        if (character === "*") {
          return ".*";
        }

        if (character === "?") {
          return ".";
        }

        return escapeRegExp(character);
      })
      .join("")}$`,
  );
  return regex.test(pathSegment);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countOccurrences(content: string, needle: string) {
  let count = 0;
  let index = content.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = content.indexOf(needle, index + needle.length);
  }

  return count;
}

function replaceFirst(content: string, oldText: string, newText: string) {
  const index = content.indexOf(oldText);
  if (index === -1) {
    return content;
  }

  return `${content.slice(0, index)}${newText}${content.slice(index + oldText.length)}`;
}

function createPreviewSnippet(content: string, index: number, length: number) {
  const contextLength = 200;
  const start = Math.max(0, index - contextLength);
  const end = Math.min(content.length, index + length + contextLength);
  return [
    start > 0 ? "..." : "",
    content.slice(start, end),
    end < content.length ? "..." : "",
  ].join("");
}

function truncatePreviewText(content: string) {
  return content.length > PREVIEW_TEXT_LIMIT
    ? `${content.slice(0, PREVIEW_TEXT_LIMIT)}...`
    : content;
}

function isEnvPathSegment(segment: string) {
  return segment === ".env" || segment.startsWith(".env.");
}

function joinGlobPath(parentPath: string, name: string) {
  return parentPath ? `${parentPath}/${name}` : name;
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

function summarizeGlobResult(
  targetPath: string,
  pattern: string,
  matchCount: number,
  truncated: boolean,
) {
  const prefix =
    matchCount === 0
      ? `路径 \`${targetPath}\` 下没有找到匹配 \`${pattern}\` 的文件。`
      : `路径 \`${targetPath}\` 下找到 ${matchCount} 个匹配 \`${pattern}\` 的文件。`;
  return truncated ? `${prefix} 结果已截断。` : prefix;
}

function summarizeWriteResult(
  targetPath: string,
  operation: FilesystemWriteOperation,
  sizeBytes: number,
) {
  return operation === "create"
    ? `已创建文件 \`${targetPath}\`，大小 ${sizeBytes} bytes。`
    : `已覆盖文件 \`${targetPath}\`，新大小 ${sizeBytes} bytes。`;
}

function summarizeEditResult(targetPath: string, replacements: number) {
  return `已编辑文件 \`${targetPath}\`，替换 ${replacements} 处文本。`;
}

function summarizeDeleteResult(targetPath: string, sizeBytes: number) {
  return `已删除文件 \`${targetPath}\`，原大小 ${sizeBytes} bytes。`;
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
