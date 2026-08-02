import { z } from "zod";
import {
  mcpBoundedIdSchema,
  mcpThreadScopeInputSchema,
  withMcpToolErrorSchema,
} from "../../contracts/common";

export const listCommandExecutionsInputSchema = mcpThreadScopeInputSchema
  .extend({
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .describe("最多返回的任务数，默认 20，最大 100。"),
  })
  .strict();

export const getCommandExecutionInputSchema = mcpThreadScopeInputSchema
  .extend({
    executionId: mcpBoundedIdSchema.describe("命令执行任务 ID。"),
  })
  .strict();

const commandExecutionStatusSchema = z.enum([
  "queued",
  "running",
  "cancel_requested",
  "completed",
  "failed",
  "timed_out",
  "sandbox_unavailable",
  "cancelled",
  "expired",
]);

const sandboxBackendSchema = z.enum([
  "macos-sandbox-exec",
  "docker",
  "mock",
]);

const timestampSchema = z.string();

const commandExecutionResultSchema = z
  .object({
    executionId: z.string(),
    command: z.string(),
    args: z.array(z.string()),
    cwd: z.string(),
    status: z.enum([
      "completed",
      "failed",
      "timed_out",
      "rejected",
      "sandbox_unavailable",
      "cancelled",
      "expired",
    ]),
    exitCode: z.number().int().nullable().optional(),
    stdout: z.string(),
    stderr: z.string(),
    outputTruncated: z.boolean(),
    durationMs: z.number().nonnegative(),
    summary: z.string(),
    finishedAt: timestampSchema,
    backend: sandboxBackendSchema.optional(),
  })
  .strict();

export const commandExecutionSnapshotSchema = z
  .object({
    agentId: z.string(),
    approvalId: z.string(),
    args: z.array(z.string()),
    attempt: z.number().int().positive(),
    backend: sandboxBackendSchema.optional(),
    cancelRequestedAt: timestampSchema.nullable(),
    command: z.string(),
    createdAt: timestampSchema,
    cwd: z.string(),
    executionId: z.string(),
    failureCode: z.string().optional(),
    finishedAt: timestampSchema.nullable(),
    lastEventId: z.string().nullable(),
    leaseExpiresAt: timestampSchema.nullable(),
    maxAttempts: z.number().int().positive(),
    outputTruncated: z.boolean(),
    parentExecutionId: z.string().nullable(),
    result: commandExecutionResultSchema.optional(),
    rootExecutionId: z.string(),
    startedAt: timestampSchema.nullable(),
    status: commandExecutionStatusSchema,
    stderr: z.string(),
    stdout: z.string(),
    summary: z.string(),
    threadId: z.string(),
    timeoutMs: z.number().int().positive(),
    toolCallId: z.string(),
    updatedAt: timestampSchema,
    workspaceId: z.string(),
  })
  .strict();

export const commandExecutionListItemSchema =
  commandExecutionSnapshotSchema
    .pick({
      args: true,
      attempt: true,
      command: true,
      createdAt: true,
      cwd: true,
      executionId: true,
      finishedAt: true,
      maxAttempts: true,
      outputTruncated: true,
      parentExecutionId: true,
      rootExecutionId: true,
      startedAt: true,
      status: true,
      summary: true,
      toolCallId: true,
      updatedAt: true,
    })
    .strict();

export const listCommandExecutionsOutputSchema = withMcpToolErrorSchema(
  z
    .object({
      ok: z.literal(true),
      count: z.number().int().nonnegative(),
      executions: z.array(commandExecutionListItemSchema),
    })
    .strict(),
);

export const getCommandExecutionOutputSchema = withMcpToolErrorSchema(
  z
    .object({
      ok: z.literal(true),
      execution: commandExecutionSnapshotSchema,
    })
    .strict(),
);

export type CommandExecutionListItem = z.infer<
  typeof commandExecutionListItemSchema
>;
