import {
  deleteMemory,
  hasMemoryStore,
  listMemories,
  saveMemory,
  type MemoryScope,
  type StoredMemory,
} from "@/lib/server/memory-store";

export type MemoryServiceContext = {
  threadId?: string;
  threadScope?: MemoryScope;
};

export type MemoryServiceError = {
  code: string;
  message: string;
};

export type SaveUserMemoryResult =
  | {
      ok: true;
      memory: StoredMemory;
      summary: string;
    }
  | MemoryServiceErrorResult;

export type QueryUserMemoriesResult =
  | {
      count: number;
      memories: StoredMemory[];
      ok: true;
      query: string | null;
      summary: string;
    }
  | MemoryServiceErrorResult;

export type DeleteUserMemoryResult =
  | {
      deleted: true;
      memoryId: string;
      ok: true;
      summary: string;
    }
  | MemoryServiceErrorResult;

export type MemoryServiceErrorResult = {
  error: MemoryServiceError;
  ok: false;
  summary: string;
};

export async function saveUserMemory(
  context: MemoryServiceContext,
  {
    category = "general",
    content,
    metadata = {},
  }: {
    category?: string;
    content: string;
    metadata?: Record<string, unknown>;
  },
): Promise<SaveUserMemoryResult> {
  const scope = getMemoryScope(context);
  if (!scope) {
    return createMissingContextError();
  }

  if (!hasMemoryStore()) {
    return createMemoryStoreUnavailableError();
  }

  const normalizedContent = content.trim();
  if (!normalizedContent) {
    return createMemoryError("invalid_content", "Memory content cannot be empty.");
  }

  const memory = await saveMemory(scope, {
    category: normalizeCategory(category),
    content: normalizedContent,
    metadata,
    sourceThreadId: context.threadId,
  });

  if (!memory) {
    return createMemoryStoreUnavailableError();
  }

  return {
    ok: true,
    memory,
    summary: memory.memoryId
      ? `已保存记忆 ${memory.memoryId}：${memory.content}`
      : `已保存记忆：${memory.content}`,
  };
}

export async function queryUserMemories(
  context: MemoryServiceContext,
  {
    limit = 20,
    query,
  }: {
    limit?: number;
    query?: string;
  } = {},
): Promise<QueryUserMemoriesResult> {
  const scope = getMemoryScope(context);
  if (!scope) {
    return createMissingContextError();
  }

  if (!hasMemoryStore()) {
    return createMemoryStoreUnavailableError();
  }

  const normalizedQuery = query?.trim() || undefined;
  const memories = await listMemories(scope, {
    limit,
    query: normalizedQuery,
  });

  return {
    ok: true,
    memories,
    count: memories.length,
    query: normalizedQuery ?? null,
    summary: summarizeMemories(memories, normalizedQuery),
  };
}

export async function deleteUserMemory(
  context: MemoryServiceContext,
  memoryId: string,
): Promise<DeleteUserMemoryResult> {
  const scope = getMemoryScope(context);
  if (!scope) {
    return createMissingContextError();
  }

  if (!hasMemoryStore()) {
    return createMemoryStoreUnavailableError();
  }

  const deleted = await deleteMemory(scope, memoryId);
  if (!deleted) {
    return createMemoryError(
      "memory_not_found",
      "No memory with this id exists for the current tenant and user.",
    );
  }

  return {
    ok: true,
    deleted: true,
    memoryId,
    summary: `已删除记忆 ${memoryId}。`,
  };
}

function getMemoryScope(context: MemoryServiceContext) {
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

function summarizeMemories(memories: StoredMemory[], query: string | undefined) {
  if (memories.length === 0) {
    return query
      ? `没有找到匹配“${query}”的长期记忆。`
      : "当前用户还没有保存长期记忆。";
  }

  const prefix = query
    ? `找到 ${memories.length} 条匹配“${query}”的长期记忆：`
    : `找到 ${memories.length} 条长期记忆：`;
  const memoryLines = memories.map((memory) =>
    memory.memoryId
      ? `- ${memory.content}（${memory.category}，id: ${memory.memoryId}）`
      : `- ${memory.content}（${memory.category}）`,
  );

  return [prefix, ...memoryLines].join("\n");
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

function createMemoryError(
  code: string,
  message: string,
): MemoryServiceErrorResult {
  return {
    ok: false,
    summary: `Memory error: ${code}, ${message}`,
    error: {
      code,
      message,
    },
  };
}
