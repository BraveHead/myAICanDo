import { z } from "zod";
import {
  mcpThreadScopeInputSchema,
  withMcpToolErrorSchema,
} from "../../contracts/common";

export const listWorkspaceFilesInputSchema = mcpThreadScopeInputSchema
  .extend({
    path: z
      .string()
      .trim()
      .min(1)
      .max(1_024)
      .default(".")
      .describe("当前线程沙盒内的相对目录，默认值为 `.`。"),
  })
  .strict();

export const readWorkspaceFileInputSchema = mcpThreadScopeInputSchema
  .extend({
    path: z
      .string()
      .trim()
      .min(1)
      .max(1_024)
      .describe("当前线程沙盒内的相对文件路径。"),
  })
  .strict();

const filesystemDirectoryEntrySchema = z
  .object({
    name: z.string(),
    path: z.string(),
    sizeBytes: z.number().int().nonnegative().optional(),
    type: z.enum(["directory", "file", "other", "symlink"]),
    updatedAt: z.string(),
  })
  .strict();

export const listWorkspaceFilesOutputSchema = withMcpToolErrorSchema(
  z
    .object({
      entries: z.array(filesystemDirectoryEntrySchema),
      ok: z.literal(true),
      path: z.string(),
      summary: z.string(),
      truncated: z.boolean(),
    })
    .strict(),
);

export const readWorkspaceFileOutputSchema = withMcpToolErrorSchema(
  z
    .object({
      content: z.string(),
      ok: z.literal(true),
      path: z.string(),
      sizeBytes: z.number().int().nonnegative(),
      summary: z.string(),
    })
    .strict(),
);
