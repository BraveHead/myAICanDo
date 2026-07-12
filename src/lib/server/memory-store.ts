import type { PoolClient } from "pg";
import { getPostgresPool, hasDatabaseUrl } from "./postgres";

export type MemoryScope = {
  tenantHashId: string;
  userHashId: string;
};

export type MemoryKey =
  | "preference.answer_language"
  | "preference.answer_style"
  | "profile.current_location"
  | "profile.nickname"
  | "general";

export type MemoryStatus = "active" | "superseded" | "deleted";

export type MemoryListStatus = MemoryStatus | "all";

export type StoredMemory = {
  category: string;
  content: string;
  createdAt: string;
  memoryId: string;
  memoryKey: MemoryKey;
  metadata: Record<string, unknown>;
  sourceThreadId: string | null;
  status: MemoryStatus;
  supersededByMemoryId: string | null;
  updatedAt: string;
  validFrom: string;
  validTo: string | null;
};

type MemoryRow = {
  category: string;
  content: string;
  created_at: Date | string;
  memory_id: string;
  memory_key: string;
  metadata: unknown;
  source_thread_id: string | null;
  status: string;
  superseded_by_memory_id: string | null;
  updated_at: Date | string;
  valid_from: Date | string;
  valid_to: Date | string | null;
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

export function inferMemoryKey(category: string, content: string): MemoryKey {
  const normalizedCategory = category.trim().toLowerCase();
  const normalizedContent = content.trim().toLowerCase();

  if (
    includesAny(normalizedCategory, ["位置", "所在地", "城市", "location"]) ||
    includesAny(normalizedContent, [
      "当前位置",
      "位置在",
      "当前在",
      "我在",
      "住在",
      "located in",
      "current location",
    ])
  ) {
    return "profile.current_location";
  }

  if (
    includesAny(normalizedCategory, ["昵称", "称呼", "nickname", "name"]) ||
    includesAny(normalizedContent, [
      "叫我",
      "称呼我",
      "我的昵称",
      "my nickname",
      "call me",
    ])
  ) {
    return "profile.nickname";
  }

  if (
    includesAny(normalizedCategory, ["语言", "回答语言", "language"]) ||
    includesAny(normalizedContent, [
      "中文回答",
      "英文回答",
      "使用中文",
      "使用英文",
      "用中文",
      "用英文",
      "回答用中文",
      "回答用英文",
      "answer in english",
      "answer in chinese",
      "respond in english",
      "respond in chinese",
      "use english",
      "use chinese",
    ])
  ) {
    return "preference.answer_language";
  }

  if (
    includesAny(normalizedCategory, ["风格", "详细程度", "style"]) ||
    includesAny(normalizedContent, [
      "简短",
      "简洁",
      "详细",
      "展开说明",
      "少废话",
      "concise",
      "brief",
      "detailed",
    ])
  ) {
    return "preference.answer_style";
  }

  return "general";
}

export async function saveMemory(
  scope: MemoryScope,
  {
    category,
    content,
    memoryKey = "general",
    metadata = {},
    sourceThreadId,
  }: {
    category: string;
    content: string;
    memoryKey?: MemoryKey;
    metadata?: Record<string, unknown>;
    sourceThreadId?: string;
  },
) {
  if (!hasDatabaseUrl()) {
    return null;
  }

  await ensureMemoryStore();

  if (memoryKey === "general") {
    return insertMemory(getPostgresPool(), scope, {
      category,
      content,
      memoryId: crypto.randomUUID(),
      memoryKey,
      metadata,
      sourceThreadId,
    });
  }

  const client = await getPostgresPool().connect();
  const newMemoryId = crypto.randomUUID();

  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1)::bigint)",
      [`memory:${scope.tenantHashId}:${scope.userHashId}:${memoryKey}`],
    );

    const existing = await client.query<MemoryRow>(
      `
        SELECT ${MEMORY_RETURNING_COLUMNS}
        FROM public.assistant_memories
        WHERE
          tenant_hash_id = $1
          AND user_hash_id = $2
          AND memory_key = $3
          AND status = 'active'
        ORDER BY updated_at DESC, created_at DESC, id DESC
        LIMIT 1
        FOR UPDATE
      `,
      [scope.tenantHashId, scope.userHashId, memoryKey],
    );

    const activeMemory = existing.rows[0];
    if (activeMemory?.content === content) {
      const updated = await client.query<MemoryRow>(
        `
          UPDATE public.assistant_memories
          SET
            category = $4,
            metadata = $5::jsonb,
            source_thread_id = $6,
            updated_at = NOW(),
            valid_to = NULL,
            superseded_by_memory_id = NULL
          WHERE tenant_hash_id = $1 AND user_hash_id = $2 AND memory_id = $3
          RETURNING ${MEMORY_RETURNING_COLUMNS}
        `,
        [
          scope.tenantHashId,
          scope.userHashId,
          activeMemory.memory_id,
          category,
          JSON.stringify(metadata),
          sourceThreadId ?? null,
        ],
      );
      await client.query("COMMIT");
      return rowToStoredMemory(updated.rows[0]);
    }

    await client.query(
      `
        UPDATE public.assistant_memories
        SET
          status = 'superseded',
          valid_to = NOW(),
          superseded_by_memory_id = $4
        WHERE
          tenant_hash_id = $1
          AND user_hash_id = $2
          AND memory_key = $3
          AND status = 'active'
      `,
      [scope.tenantHashId, scope.userHashId, memoryKey, newMemoryId],
    );

    const memory = await insertMemory(client, scope, {
      category,
      content,
      memoryId: newMemoryId,
      memoryKey,
      metadata,
      sourceThreadId,
    });

    await client.query("COMMIT");
    return memory;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listMemories(
  scope: MemoryScope,
  {
    limit = 20,
    query,
    status = "active",
  }: {
    limit?: number;
    query?: string;
    status?: MemoryListStatus;
  } = {},
) {
  if (!hasDatabaseUrl()) {
    return [];
  }

  await ensureMemoryStore();

  const normalizedQuery = query?.trim() || null;
  const boundedLimit = Math.min(Math.max(limit, 1), 50);
  const normalizedStatus = normalizeMemoryListStatus(status);
  const result = await getPostgresPool().query<MemoryRow>(
    `
      SELECT ${MEMORY_RETURNING_COLUMNS}
      FROM public.assistant_memories
      WHERE
        tenant_hash_id = $1
        AND user_hash_id = $2
        AND ($3::text = 'all' OR status = $3)
        AND (
          $4::text IS NULL
          OR content ILIKE '%' || $4 || '%'
          OR category ILIKE '%' || $4 || '%'
          OR memory_key ILIKE '%' || $4 || '%'
        )
      ORDER BY updated_at DESC, created_at DESC, id DESC
      LIMIT $5
    `,
    [
      scope.tenantHashId,
      scope.userHashId,
      normalizedStatus,
      normalizedQuery,
      boundedLimit,
    ],
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
      UPDATE public.assistant_memories
      SET
        status = 'deleted',
        valid_to = COALESCE(valid_to, NOW()),
        updated_at = NOW()
      WHERE
        tenant_hash_id = $1
        AND user_hash_id = $2
        AND memory_id = $3
        AND status <> 'deleted'
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
    "以下是当前用户显式保存且仍然有效的长期记忆，按从新到旧排序。",
    "除非用户当前请求明确要求改变，否则应遵循这些偏好和事实。",
    "",
    ...memoryLines,
  ].join("\n");
}

const MEMORY_RETURNING_COLUMNS = `
  memory_id,
  content,
  category,
  metadata,
  source_thread_id,
  memory_key,
  status,
  valid_from,
  valid_to,
  superseded_by_memory_id,
  created_at,
  updated_at
`;

async function insertMemory(
  client: Pick<PoolClient, "query">,
  scope: MemoryScope,
  {
    category,
    content,
    memoryId,
    memoryKey,
    metadata,
    sourceThreadId,
  }: {
    category: string;
    content: string;
    memoryId: string;
    memoryKey: MemoryKey;
    metadata: Record<string, unknown>;
    sourceThreadId?: string;
  },
) {
  const result = await client.query<MemoryRow>(
    `
      INSERT INTO public.assistant_memories (
        tenant_hash_id,
        user_hash_id,
        memory_id,
        content,
        category,
        metadata,
        source_thread_id,
        memory_key,
        status,
        valid_from
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, 'active', NOW())
      RETURNING ${MEMORY_RETURNING_COLUMNS}
    `,
    [
      scope.tenantHashId,
      scope.userHashId,
      memoryId,
      content,
      category,
      JSON.stringify(metadata),
      sourceThreadId ?? null,
      memoryKey,
    ],
  );

  return rowToStoredMemory(result.rows[0]);
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
      memory_key TEXT NOT NULL DEFAULT 'general',
      status TEXT NOT NULL DEFAULT 'active',
      valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      valid_to TIMESTAMPTZ,
      superseded_by_memory_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    ALTER TABLE public.assistant_memories
    ADD COLUMN IF NOT EXISTS memory_key TEXT
  `);
  await pool.query(`
    ALTER TABLE public.assistant_memories
    ADD COLUMN IF NOT EXISTS status TEXT
  `);
  await pool.query(`
    ALTER TABLE public.assistant_memories
    ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ
  `);
  await pool.query(`
    ALTER TABLE public.assistant_memories
    ADD COLUMN IF NOT EXISTS valid_to TIMESTAMPTZ
  `);
  await pool.query(`
    ALTER TABLE public.assistant_memories
    ADD COLUMN IF NOT EXISTS superseded_by_memory_id TEXT
  `);

  await pool.query(`
    UPDATE public.assistant_memories
    SET memory_key = infer.memory_key
    FROM (
      SELECT
        id,
        CASE
          WHEN category ILIKE '%位置%'
            OR category ILIKE '%所在地%'
            OR category ILIKE '%城市%'
            OR category ILIKE '%location%'
            OR content ILIKE '%当前位置%'
            OR content ILIKE '%位置在%'
            OR content ILIKE '%当前在%'
            OR content ILIKE '%我在%'
            OR content ILIKE '%住在%'
            OR content ILIKE '%located in%'
            OR content ILIKE '%current location%'
            THEN 'profile.current_location'
          WHEN category ILIKE '%昵称%'
            OR category ILIKE '%称呼%'
            OR category ILIKE '%nickname%'
            OR category ILIKE '%name%'
            OR content ILIKE '%叫我%'
            OR content ILIKE '%称呼我%'
            OR content ILIKE '%我的昵称%'
            OR content ILIKE '%my nickname%'
            OR content ILIKE '%call me%'
            THEN 'profile.nickname'
          WHEN category ILIKE '%语言%'
            OR category ILIKE '%回答语言%'
            OR category ILIKE '%language%'
            OR content ILIKE '%中文回答%'
            OR content ILIKE '%英文回答%'
            OR content ILIKE '%使用中文%'
            OR content ILIKE '%使用英文%'
            OR content ILIKE '%用中文%'
            OR content ILIKE '%用英文%'
            OR content ILIKE '%回答用中文%'
            OR content ILIKE '%回答用英文%'
            OR content ILIKE '%answer in english%'
            OR content ILIKE '%answer in chinese%'
            OR content ILIKE '%respond in english%'
            OR content ILIKE '%respond in chinese%'
            OR content ILIKE '%use english%'
            OR content ILIKE '%use chinese%'
            THEN 'preference.answer_language'
          WHEN category ILIKE '%风格%'
            OR category ILIKE '%详细程度%'
            OR category ILIKE '%style%'
            OR content ILIKE '%简短%'
            OR content ILIKE '%简洁%'
            OR content ILIKE '%详细%'
            OR content ILIKE '%展开说明%'
            OR content ILIKE '%少废话%'
            OR content ILIKE '%concise%'
            OR content ILIKE '%brief%'
            OR content ILIKE '%detailed%'
            THEN 'preference.answer_style'
          ELSE 'general'
        END AS memory_key
      FROM public.assistant_memories
      WHERE memory_key IS NULL OR memory_key = ''
    ) AS infer
    WHERE public.assistant_memories.id = infer.id
  `);

  await pool.query(`
    UPDATE public.assistant_memories
    SET status = 'active'
    WHERE status IS NULL OR status = ''
  `);
  await pool.query(`
    UPDATE public.assistant_memories
    SET valid_from = created_at
    WHERE valid_from IS NULL
  `);

  await pool.query(`
    ALTER TABLE public.assistant_memories
    ALTER COLUMN memory_key SET DEFAULT 'general',
    ALTER COLUMN memory_key SET NOT NULL,
    ALTER COLUMN status SET DEFAULT 'active',
    ALTER COLUMN status SET NOT NULL,
    ALTER COLUMN valid_from SET DEFAULT NOW(),
    ALTER COLUMN valid_from SET NOT NULL
  `);

  await resolveActiveMemoryConflicts();

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS assistant_memories_scope_memory_idx
    ON public.assistant_memories (tenant_hash_id, user_hash_id, memory_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS assistant_memories_scope_updated_idx
    ON public.assistant_memories (tenant_hash_id, user_hash_id, updated_at DESC)
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS assistant_memories_active_memory_key_idx
    ON public.assistant_memories (tenant_hash_id, user_hash_id, memory_key)
    WHERE status = 'active' AND memory_key <> 'general'
  `);
}

async function resolveActiveMemoryConflicts() {
  await getPostgresPool().query(`
    WITH ranked AS (
      SELECT
        id,
        first_value(memory_id) OVER memory_scope AS winner_memory_id,
        first_value(updated_at) OVER memory_scope AS winner_updated_at,
        row_number() OVER memory_scope AS active_rank
      FROM public.assistant_memories
      WHERE status = 'active' AND memory_key <> 'general'
      WINDOW memory_scope AS (
        PARTITION BY tenant_hash_id, user_hash_id, memory_key
        ORDER BY updated_at DESC, created_at DESC, id DESC
      )
    )
    UPDATE public.assistant_memories AS memory
    SET
      status = 'superseded',
      valid_to = ranked.winner_updated_at,
      superseded_by_memory_id = ranked.winner_memory_id
    FROM ranked
    WHERE memory.id = ranked.id AND ranked.active_rank > 1
  `);
}

function rowToStoredMemory(row: MemoryRow): StoredMemory {
  return {
    category: row.category,
    content: row.content,
    createdAt: toIsoString(row.created_at),
    memoryId: row.memory_id,
    memoryKey: normalizeMemoryKey(row.memory_key),
    metadata: isRecord(row.metadata) ? row.metadata : {},
    sourceThreadId: row.source_thread_id,
    status: normalizeMemoryStatus(row.status),
    supersededByMemoryId: row.superseded_by_memory_id,
    updatedAt: toIsoString(row.updated_at),
    validFrom: toIsoString(row.valid_from),
    validTo: row.valid_to ? toIsoString(row.valid_to) : null,
  };
}

function normalizeMemoryKey(value: string): MemoryKey {
  if (
    value === "preference.answer_language" ||
    value === "preference.answer_style" ||
    value === "profile.current_location" ||
    value === "profile.nickname"
  ) {
    return value;
  }

  return "general";
}

function normalizeMemoryStatus(value: string): MemoryStatus {
  if (value === "superseded" || value === "deleted") {
    return value;
  }

  return "active";
}

function normalizeMemoryListStatus(status: MemoryListStatus) {
  if (status === "superseded" || status === "deleted" || status === "all") {
    return status;
  }

  return "active";
}

function toIsoString(value: Date | string) {
  return typeof value === "string" ? value : value.toISOString();
}

function includesAny(value: string, patterns: string[]) {
  return patterns.some((pattern) => value.includes(pattern));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
