import { tool } from "langchain";
import * as z from "zod";
import {
  FILESYSTEM_MAX_SEARCH_RESULTS,
  listFilesystemDirectory,
  readFilesystemFile,
  searchFilesystemText,
  type FilesystemServiceContext,
} from "@/lib/agent/services/filesystem-service";

const relativePathSchema = z
  .string()
  .optional()
  .describe("Relative path inside the current thread sandbox. Defaults to '.'.");

export function createFilesystemTools(context: FilesystemServiceContext) {
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
  ];
}

function jsonResult(value: unknown) {
  return JSON.stringify(value);
}
