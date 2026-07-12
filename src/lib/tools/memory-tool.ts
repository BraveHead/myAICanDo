import { tool } from "langchain";
import * as z from "zod";
import {
  deleteUserMemory,
  queryUserMemories,
  saveUserMemory,
  type MemoryServiceContext,
} from "@/lib/agent/services/memory-service";

const memoryCategorySchema = z
  .string()
  .min(1)
  .max(80)
  .optional()
  .describe("Memory category. Defaults to 'general'.");

export function createMemoryTools(context: MemoryServiceContext) {
  return [
    createSaveMemoryTool(context),
    tool(
      async ({ limit = 20, query }) =>
        jsonResult(
          await queryUserMemories(context, {
            limit,
            query,
          }),
        ),
      {
        name: "list_memories",
        description:
          "List or search explicit long-term memories for the current tenant and user. Use this when the user asks what you remember or asks for a saved preference/fact.",
        schema: z.object({
          query: z
            .string()
            .max(200)
            .optional()
            .describe("Optional keyword used to filter memory content/category."),
          limit: z
            .number()
            .int()
            .min(1)
            .max(50)
            .optional()
            .describe("Maximum number of memories to return."),
        }),
      },
    ),
    createDeleteMemoryTool(context),
  ];
}

export function createMemoryMutationTools(context: MemoryServiceContext) {
  return [createSaveMemoryTool(context), createDeleteMemoryTool(context)];
}

function createSaveMemoryTool(context: MemoryServiceContext) {
  return tool(
    async ({ category = "general", content, metadata = {} }) =>
      jsonResult(
        await saveUserMemory(context, {
          category,
          content,
          metadata,
        }),
      ),
    {
      name: "save_memory",
      description:
        "Save one explicit long-term user memory for the current tenant and user. Only call this when the user clearly asks you to remember or save something.",
      schema: z.object({
        content: z
          .string()
          .min(1)
          .max(2_000)
          .describe("The concise, factual memory content to remember."),
        category: memoryCategorySchema,
        metadata: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Optional structured metadata for this memory."),
      }),
    },
  );
}

function createDeleteMemoryTool(context: MemoryServiceContext) {
  return tool(
    async ({ memoryId }) => jsonResult(await deleteUserMemory(context, memoryId)),
    {
      name: "delete_memory",
      description:
        "Delete one explicit long-term memory for the current tenant and user by memory id. If the user does not provide a clear id, list memories first.",
      schema: z.object({
        memoryId: z.string().min(1).describe("The memory_id to delete."),
      }),
    },
  );
}

function jsonResult(value: unknown) {
  return JSON.stringify(value);
}
