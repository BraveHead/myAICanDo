import { tool } from "langchain";
import * as z from "zod";
import {
  deleteFilesystemFile,
  editFilesystemFile,
  FILESYSTEM_MAX_EDIT_REPLACEMENTS,
  FILESYSTEM_MAX_GLOB_RESULTS,
  FILESYSTEM_MAX_SEARCH_RESULTS,
  FILESYSTEM_MAX_WRITE_BYTES,
  globFilesystemFiles,
  listFilesystemDirectory,
  readFilesystemFile,
  searchFilesystemText,
  writeFilesystemFile,
  type FilesystemServiceContext,
} from "@/lib/agent/services/filesystem-service";

const relativePathSchema = z
  .string()
  .optional()
  .describe("Relative path inside the current thread sandbox. Defaults to '.'.");

const requiredRelativePathSchema = z
  .string()
  .min(1)
  .describe("Relative path inside the current thread sandbox.");

export function createFilesystemTools(context: FilesystemServiceContext) {
  return [
    ...createReadonlyFilesystemTools(context),
    tool(
      async ({ content, path: inputPath }) =>
        jsonResult(
          await writeFilesystemFile(context, {
            content,
            path: inputPath,
          }),
        ),
      {
        name: "write_file",
        description:
          "Create or overwrite a UTF-8 text file in the current thread sandbox. Only workspace/** and notes/** are writable and execution requires user approval.",
        schema: z.object({
          path: requiredRelativePathSchema,
          content: z
            .string()
            .max(FILESYSTEM_MAX_WRITE_BYTES)
            .describe("UTF-8 text content to write."),
        }),
      },
    ),
    tool(
      async ({
        newText,
        oldText,
        path: inputPath,
        replaceAll = false,
      }) =>
        jsonResult(
          await editFilesystemFile(context, {
            newText,
            oldText,
            path: inputPath,
            replaceAll,
          }),
        ),
      {
        name: "edit_file",
        description:
          "Edit a UTF-8 text file with exact string replacement. By default oldText must match exactly once; replaceAll can replace up to the configured limit. Execution requires user approval.",
        schema: z.object({
          path: requiredRelativePathSchema,
          oldText: z
            .string()
            .min(1)
            .describe("Exact text to replace. Must be non-empty."),
          newText: z.string().describe("Replacement text."),
          replaceAll: z
            .boolean()
            .optional()
            .describe(
              `Replace every occurrence instead of requiring a unique match. Maximum ${FILESYSTEM_MAX_EDIT_REPLACEMENTS} replacements.`,
            ),
        }),
      },
    ),
    tool(
      async ({ path: inputPath }) =>
        jsonResult(
          await deleteFilesystemFile(context, {
            path: inputPath,
          }),
        ),
      {
        name: "delete_file",
        description:
          "Delete a regular file in the current thread sandbox. Only workspace/** and notes/** are deletable; directories and symlinks are rejected. Execution requires user approval.",
        schema: z.object({
          path: requiredRelativePathSchema,
        }),
      },
    ),
  ];
}

export function createReadonlyFilesystemTools(context: FilesystemServiceContext) {
  return [
    tool(
      async ({ path: inputPath = "." }) =>
        jsonResult(await listFilesystemDirectory(context, inputPath)),
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
      async ({ path: inputPath }) =>
        jsonResult(await readFilesystemFile(context, inputPath)),
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
        maxResults = FILESYSTEM_MAX_SEARCH_RESULTS,
        path: inputPath = ".",
        query,
      }) =>
        jsonResult(
          await searchFilesystemText(context, {
            caseSensitive,
            maxResults,
            path: inputPath,
            query,
          }),
        ),
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
            .max(FILESYSTEM_MAX_SEARCH_RESULTS)
            .optional()
            .describe("Maximum number of matches to return."),
        }),
      },
    ),
    tool(
      async ({ maxResults = FILESYSTEM_MAX_GLOB_RESULTS, path: inputPath = ".", pattern }) =>
        jsonResult(
          await globFilesystemFiles(context, {
            maxResults,
            path: inputPath,
            pattern,
          }),
        ),
      {
        name: "glob_files",
        description:
          "Find files in the current thread sandbox using a relative glob pattern. Supports *, ?, and **. Returns matching files only, not directories.",
        schema: z.object({
          pattern: z
            .string()
            .min(1)
            .max(200)
            .describe("Relative glob pattern such as '**/*.md' or 'workspace/*.txt'."),
          path: relativePathSchema,
          maxResults: z
            .number()
            .int()
            .min(1)
            .max(FILESYSTEM_MAX_GLOB_RESULTS)
            .optional()
            .describe("Maximum number of matching files to return."),
        }),
      },
    ),
  ];
}

function jsonResult(value: unknown) {
  return JSON.stringify(value);
}
