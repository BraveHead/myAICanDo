import { z } from "zod";

export const mcpBoundedIdSchema = z.string().trim().min(1).max(256);

export const mcpThreadScopeInputSchema = z
  .object({
    workspaceId: mcpBoundedIdSchema.describe("当前租户中的工作区 ID。"),
    threadId: mcpBoundedIdSchema.describe(
      "已持久化并绑定工作区的线程 ID。",
    ),
  })
  .strict();

export const mcpToolErrorSchema = z
  .object({
    ok: z.literal(false),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        requestId: z.string(),
      })
      .strict(),
  })
  .strict();

export function withMcpToolErrorSchema<SuccessSchema extends z.ZodType>(
  successSchema: SuccessSchema,
) {
  return z.union([successSchema, mcpToolErrorSchema]);
}

export function parseMcpThreadScopeInput(
  input: unknown,
): McpThreadScopeInput | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const inputRecord = input as Record<string, unknown>;
  const result = mcpThreadScopeInputSchema.safeParse({
    threadId: inputRecord.threadId,
    workspaceId: inputRecord.workspaceId,
  });
  return result.success ? result.data : null;
}

export type McpThreadScopeInput = z.infer<
  typeof mcpThreadScopeInputSchema
>;
export type McpToolError = z.infer<typeof mcpToolErrorSchema>;
