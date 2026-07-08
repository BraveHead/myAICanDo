import { tool } from "langchain";
import * as z from "zod";
import {
  deleteMemory,
  hasMemoryStore,
  listMemories,
  saveMemory,
} from "@/lib/server/memory-store";

type MemoryToolContext = {
  threadId?: string;
  threadScope?: {
    tenantHashId: string;
    userHashId: string;
  };
};

const memoryCategorySchema = z
  .string()
  .min(1)
  .max(80)
  .optional()
  .describe("Memory category. Defaults to 'general'.");

export function createMemoryTools(context: MemoryToolContext) {
  return [
    tool(
      async ({ category = "general", content, metadata = {} }) => {
        const scope = getMemoryScope(context);
        if (!scope) {
          return jsonResult(createMissingContextError());
        }

        if (!hasMemoryStore()) {
          return jsonResult(createMemoryStoreUnavailableError());
        }

        const normalizedContent = content.trim();
        if (!normalizedContent) {
          return jsonResult(
            createMemoryError("invalid_content", "Memory content cannot be empty."),
          );
        }

        const memory = await saveMemory(scope, {
          category: normalizeCategory(category),
          content: normalizedContent,
          metadata,
          sourceThreadId: context.threadId,
        });

        if (!memory) {
          return jsonResult(createMemoryStoreUnavailableError());
        }

        return jsonResult({
          ok: true,
          memory,
        });
      },
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
    ),
    tool(
      async ({ limit = 20, query }) => {
        const scope = getMemoryScope(context);
        if (!scope) {
          return jsonResult(createMissingContextError());
        }

        if (!hasMemoryStore()) {
          return jsonResult(createMemoryStoreUnavailableError());
        }

        const memories = await listMemories(scope, {
          limit,
          query,
        });

        return jsonResult({
          ok: true,
          memories,
          count: memories.length,
          query: query?.trim() || null,
        });
      },
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
    tool(
      async ({ memoryId }) => {
        const scope = getMemoryScope(context);
        if (!scope) {
          return jsonResult(createMissingContextError());
        }

        if (!hasMemoryStore()) {
          return jsonResult(createMemoryStoreUnavailableError());
        }

        const deleted = await deleteMemory(scope, memoryId);
        if (!deleted) {
          return jsonResult(
            createMemoryError(
              "memory_not_found",
              "No memory with this id exists for the current tenant and user.",
            ),
          );
        }

        return jsonResult({
          ok: true,
          deleted: true,
          memoryId,
        });
      },
      {
        name: "delete_memory",
        description:
          "Delete one explicit long-term memory for the current tenant and user by memory id. If the user does not provide a clear id, list memories first.",
        schema: z.object({
          memoryId: z.string().min(1).describe("The memory_id to delete."),
        }),
      },
    ),
  ];
}

function getMemoryScope(context: MemoryToolContext) {
  if (!context.threadScope) {
    return null;
  }

  return {
    tenantHashId: context.threadScope.tenantHashId,
    userHashId: context.threadScope.userHashId,
  };
}

function normalizeCategory(category: string | undefined) {
  return category?.trim() || "general";
}

function createMissingContextError() {
  return createMemoryError(
    "missing_context",
    "Memory tools require tenant and user context.",
  );
}

function createMemoryStoreUnavailableError() {
  return createMemoryError(
    "memory_store_unavailable",
    "Memory store requires DATABASE_URL.",
  );
}

function createMemoryError(code: string, message: string) {
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
