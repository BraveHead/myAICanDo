import {
  deleteMemory,
  extractMemoryByRules,
  hasMemoryStore,
  listMemories,
  saveMemory,
  type MemoryKey,
  type MemoryListStatus,
  type MemoryScope,
  type StoredMemory,
} from "@/lib/server/memory-store";

export type MemoryServiceContext = {
  threadId?: string;
  threadScope?: MemoryScope;
};

type MemoryServiceError = {
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
      status: MemoryListStatus;
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

type MemoryServiceErrorResult = {
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
  const normalizedCategory = normalizeCategory(category);
  if (!normalizedContent) {
    return createMemoryError("invalid_content", "Memory content cannot be empty.");
  }
  const extraction = extractMemoryByRules(normalizedCategory, normalizedContent);

  const memory = await saveMemory(scope, {
    category: normalizedCategory,
    content: normalizedContent,
    extraction,
    memoryKey: extraction.key,
    metadata,
    sourceThreadId: context.threadId,
  });

  if (!memory) {
    return createMemoryStoreUnavailableError();
  }

  return {
    ok: true,
    memory,
    summary: createSavedMemorySummary(memory),
  };
}

export async function queryUserMemories(
  context: MemoryServiceContext,
  {
    includeHistory = false,
    limit = 20,
    memoryKey,
    query,
    status,
  }: {
    includeHistory?: boolean;
    limit?: number;
    memoryKey?: MemoryKey;
    query?: string;
    status?: MemoryListStatus;
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
  const resolvedStatus = status ?? (includeHistory ? "all" : "active");
  const memories = await listMemories(scope, {
    limit,
    memoryKey,
    query: normalizedQuery,
    status: resolvedStatus,
  });

  return {
    ok: true,
    memories,
    count: memories.length,
    status: resolvedStatus,
    query: normalizedQuery ?? null,
    summary: summarizeMemories(memories, normalizedQuery, resolvedStatus),
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

function summarizeMemories(
  memories: StoredMemory[],
  query: string | undefined,
  status: MemoryListStatus,
) {
  if (memories.length === 0) {
    return query
      ? `没有找到匹配“${query}”的长期记忆。`
      : status === "active"
        ? "当前用户还没有保存有效长期记忆。"
        : `当前用户没有 ${status} 状态的长期记忆。`;
  }

  const prefix = query
    ? `找到 ${memories.length} 条匹配“${query}”的 ${status} 长期记忆：`
    : `找到 ${memories.length} 条 ${status} 长期记忆：`;
  const memoryLines = memories.map((memory) =>
    memory.memoryId
      ? `- ${memory.content}（${memory.category}，${formatMemoryKeyValue(memory)}，${memory.status}，id: ${memory.memoryId}）`
      : `- ${memory.content}（${memory.category}，${formatMemoryKeyValue(memory)}，${memory.status}）`,
  );

  return [prefix, ...memoryLines].join("\n");
}

function createSavedMemorySummary(memory: StoredMemory) {
  const idPart = memory.memoryId ? ` ${memory.memoryId}` : "";
  const keyValue = formatMemoryKeyValue(memory);
  return `已保存记忆${idPart}：${memory.content}（${keyValue}）`;
}

function formatMemoryKeyValue(memory: StoredMemory) {
  return memory.extraction?.value
    ? `${memory.memoryKey}=${memory.extraction.value}`
    : memory.memoryKey;
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
