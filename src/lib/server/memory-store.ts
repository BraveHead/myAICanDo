import { getPostgresPool, hasDatabaseUrl } from "./postgres";

export type MemoryScope = {
  tenantHashId: string;
  userHashId: string;
};

export type StoredMemory = {
  category: string;
  content: string;
  createdAt: string;
  memoryId: string;
  metadata: Record<string, unknown>;
  sourceThreadId: string | null;
  updatedAt: string;
};

type MemoryRow = {
  category: string;
  content: string;
  created_at: Date | string;
  memory_id: string;
  metadata: unknown;
  source_thread_id: string | null;
  updated_at: Date | string;
};

let setupPromise: Promise<void> | null = null;

export function hasMemoryStore() {
  return hasDatabaseUrl();
}

export async function ensureMemoryStore() {
  if (!hasDatabaseUrl()) {
    return;
  }

  setupPromise ??= setupAssistantMemoriesTable();

  await setupPromise;
}

export async function saveMemory(
  scope: MemoryScope,
  {
    category,
    content,
    metadata = {},
    sourceThreadId,
  }: {
    category: string;
    content: string;
    metadata?: Record<string, unknown>;
    sourceThreadId?: string;
  },
) {
  if (!hasDatabaseUrl()) {
    return null;
  }

  await ensureMemoryStore();

  const result = await getPostgresPool().query<MemoryRow>(
    `
      INSERT INTO public.assistant_memories (
        tenant_hash_id,
        user_hash_id,
        memory_id,
        content,
        category,
        metadata,
        source_thread_id
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
      RETURNING memory_id, content, category, metadata, source_thread_id, created_at, updated_at
    `,
    [
      scope.tenantHashId,
      scope.userHashId,
      crypto.randomUUID(),
      content,
      category,
      JSON.stringify(metadata),
      sourceThreadId ?? null,
    ],
  );

  return rowToStoredMemory(result.rows[0]);
}

export async function listMemories(
  scope: MemoryScope,
  {
    limit = 20,
    query,
  }: {
    limit?: number;
    query?: string;
  } = {},
) {
  if (!hasDatabaseUrl()) {
    return [];
  }

  await ensureMemoryStore();

  const normalizedQuery = query?.trim() || null;
  const boundedLimit = Math.min(Math.max(limit, 1), 50);
  const result = await getPostgresPool().query<MemoryRow>(
    `
      SELECT memory_id, content, category, metadata, source_thread_id, created_at, updated_at
      FROM public.assistant_memories
      WHERE
        tenant_hash_id = $1
        AND user_hash_id = $2
        AND (
          $3::text IS NULL
          OR content ILIKE '%' || $3 || '%'
          OR category ILIKE '%' || $3 || '%'
        )
      ORDER BY updated_at DESC
      LIMIT $4
    `,
    [scope.tenantHashId, scope.userHashId, normalizedQuery, boundedLimit],
  );

  return result.rows.map(rowToStoredMemory);
}

export async function deleteMemory(scope: MemoryScope, memoryId: string) {
  if (!hasDatabaseUrl()) {
    return false;
  }

  await ensureMemoryStore();

  const result = await getPostgresPool().query(
    `
      DELETE FROM public.assistant_memories
      WHERE tenant_hash_id = $1 AND user_hash_id = $2 AND memory_id = $3
    `,
    [scope.tenantHashId, scope.userHashId, memoryId],
  );

  return Number(result.rowCount ?? 0) > 0;
}

export function formatMemoriesForPrompt(memories: StoredMemory[]) {
  if (memories.length === 0) {
    return null;
  }

  const memoryLines = memories.map((memory, index) => {
    const category = memory.category ? ` [${memory.category}]` : "";
    return `${index + 1}.${category} ${memory.content}`;
  });

  return [
    "以下是当前用户显式保存的长期记忆，按从新到旧排序。",
    "如果多条记忆存在冲突，优先遵循更靠前、更新的记忆。",
    "除非用户当前请求明确要求改变，否则应遵循这些偏好和事实。",
    "",
    ...memoryLines,
  ].join("\n");
}

async function setupAssistantMemoriesTable() {
  const pool = getPostgresPool();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.assistant_memories (
      id BIGSERIAL PRIMARY KEY,
      tenant_hash_id TEXT NOT NULL,
      user_hash_id TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      content TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      source_thread_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS assistant_memories_scope_memory_idx
    ON public.assistant_memories (tenant_hash_id, user_hash_id, memory_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS assistant_memories_scope_updated_idx
    ON public.assistant_memories (tenant_hash_id, user_hash_id, updated_at DESC)
  `);
}

function rowToStoredMemory(row: MemoryRow): StoredMemory {
  return {
    category: row.category,
    content: row.content,
    createdAt: toIsoString(row.created_at),
    memoryId: row.memory_id,
    metadata: isRecord(row.metadata) ? row.metadata : {},
    sourceThreadId: row.source_thread_id,
    updatedAt: toIsoString(row.updated_at),
  };
}

function toIsoString(value: Date | string) {
  return typeof value === "string" ? value : value.toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
