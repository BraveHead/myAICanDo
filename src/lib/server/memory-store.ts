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

export const MEMORY_KEYS = [
  "preference.answer_language",
  "preference.answer_style",
  "profile.current_location",
  "profile.nickname",
  "general",
] as const satisfies readonly MemoryKey[];

type MemoryStatus = "active" | "superseded" | "deleted";

export type MemoryListStatus = MemoryStatus | "all";

type MemoryExtractionSource = "model" | "rule";

export type MemoryExtraction = {
  category: string;
  confidence: number;
  key: MemoryKey;
  reason?: string;
  source: MemoryExtractionSource;
  value: string | null;
};

export type StoredMemory = {
  category: string;
  content: string;
  createdAt: string;
  extraction: MemoryExtraction | null;
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

export type MemorySavePreview = {
  category: string;
  content: string;
  extraction: MemoryExtraction;
  memoryKey: MemoryKey;
  newValue: string | null;
  replacedMemory: StoredMemory | null;
  replacedValue: string | null;
  willReplace: boolean;
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

async function ensureMemoryStore() {
  if (!hasDatabaseUrl()) {
    return;
  }

  setupPromise ??= setupAssistantMemoriesTable();

  await setupPromise;
}

export function extractMemoryByRules(
  category: string,
  content: string,
): MemoryExtraction {
  const normalizedCategory = category.trim().toLowerCase();
  const normalizedContent = content.trim().toLowerCase();
  const resultCategory = normalizeMemoryCategory(category);

  const answerLanguage = extractAnswerLanguage(normalizedContent);
  if (
    answerLanguage ||
    includesAny(normalizedCategory, ["语言", "回答语言", "language"])
  ) {
    return {
      category: resultCategory === "general" ? "偏好" : resultCategory,
      confidence: answerLanguage ? 0.95 : 0.62,
      key: "preference.answer_language",
      reason: answerLanguage
        ? "匹配到回答语言偏好"
        : "分类指向回答语言，但未提取到稳定值",
      source: "rule",
      value: answerLanguage,
    };
  }

  const location = extractCurrentLocation(content);
  if (
    location ||
    includesAny(normalizedCategory, ["位置", "所在地", "城市", "location"])
  ) {
    return {
      category: resultCategory === "general" ? "位置" : resultCategory,
      confidence: location ? 0.92 : 0.62,
      key: "profile.current_location",
      reason: location
        ? "匹配到当前位置表达"
        : "分类指向位置，但未提取到稳定值",
      source: "rule",
      value: location,
    };
  }

  const nickname = extractNickname(content);
  if (
    nickname ||
    includesAny(normalizedCategory, ["昵称", "称呼", "nickname", "name"])
  ) {
    return {
      category: resultCategory === "general" ? "称呼" : resultCategory,
      confidence: nickname ? 0.92 : 0.62,
      key: "profile.nickname",
      reason: nickname
        ? "匹配到用户称呼表达"
        : "分类指向称呼，但未提取到稳定值",
      source: "rule",
      value: nickname,
    };
  }

  const answerStyle = extractAnswerStyle(normalizedContent);
  if (
    answerStyle ||
    includesAny(normalizedCategory, ["风格", "详细程度", "style"])
  ) {
    return {
      category: resultCategory === "general" ? "偏好" : resultCategory,
      confidence: answerStyle ? 0.9 : 0.6,
      key: "preference.answer_style",
      reason: answerStyle
        ? "匹配到回答风格偏好"
        : "分类指向回答风格，但未提取到稳定值",
      source: "rule",
      value: answerStyle,
    };
  }

  return {
    category: resultCategory,
    confidence: 0.2,
    key: "general",
    reason: "未匹配到稳定的结构化记忆类型",
    source: "rule",
    value: null,
  };
}

export async function saveMemory(
  scope: MemoryScope,
  {
    category,
    content,
    extraction,
    memoryKey,
    metadata = {},
    sourceThreadId,
  }: {
    category: string;
    content: string;
    extraction?: MemoryExtraction;
    memoryKey?: MemoryKey;
    metadata?: Record<string, unknown>;
    sourceThreadId?: string;
  },
) {
  if (!hasDatabaseUrl()) {
    return null;
  }

  await ensureMemoryStore();

  const normalizedCategory = normalizeMemoryCategory(category);
  const normalizedContent = content.trim();
  const memoryExtraction = normalizeMemoryExtraction(
    extraction ?? extractMemoryByRules(normalizedCategory, normalizedContent),
    normalizedCategory,
  );
  const resolvedMemoryKey = memoryKey ?? memoryExtraction.key;
  const resolvedExtraction =
    memoryExtraction.key === resolvedMemoryKey
      ? memoryExtraction
      : {
          ...memoryExtraction,
          key: resolvedMemoryKey,
          reason: memoryExtraction.reason
            ? `${memoryExtraction.reason}；memory_key 由调用方覆盖`
            : "memory_key 由调用方覆盖",
        };
  const metadataWithExtraction = mergeMemoryExtractionMetadata(
    metadata,
    resolvedExtraction,
  );
  const resolvedCategory =
    normalizedCategory === "general"
      ? resolvedExtraction.category
      : normalizedCategory;

  if (resolvedMemoryKey === "general") {
    return insertMemory(getPostgresPool(), scope, {
      category: resolvedCategory,
      content: normalizedContent,
      memoryId: crypto.randomUUID(),
      memoryKey: resolvedMemoryKey,
      metadata: metadataWithExtraction,
      sourceThreadId,
    });
  }

  const client = await getPostgresPool().connect();
  const newMemoryId = crypto.randomUUID();

  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext($1)::bigint)",
      [`memory:${scope.tenantHashId}:${scope.userHashId}:${resolvedMemoryKey}`],
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
      [scope.tenantHashId, scope.userHashId, resolvedMemoryKey],
    );

    const activeMemory = existing.rows[0];
    if (activeMemory?.content === normalizedContent) {
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
          resolvedCategory,
          JSON.stringify(metadataWithExtraction),
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
      [scope.tenantHashId, scope.userHashId, resolvedMemoryKey, newMemoryId],
    );

    const memory = await insertMemory(client, scope, {
      category: resolvedCategory,
      content: normalizedContent,
      memoryId: newMemoryId,
      memoryKey: resolvedMemoryKey,
      metadata: metadataWithExtraction,
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
    memoryKey,
    query,
    status = "active",
  }: {
    limit?: number;
    memoryKey?: MemoryKey;
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
  const normalizedMemoryKey = memoryKey
    ? normalizeMemoryKey(memoryKey)
    : null;
  const normalizedStatus = normalizeMemoryListStatus(status);
  const result = await getPostgresPool().query<MemoryRow>(
    `
      SELECT ${MEMORY_RETURNING_COLUMNS}
      FROM public.assistant_memories
      WHERE
        tenant_hash_id = $1
        AND user_hash_id = $2
        AND ($3::text = 'all' OR status = $3)
        AND ($4::text IS NULL OR memory_key = $4)
        AND (
          $5::text IS NULL
          OR content ILIKE '%' || $5 || '%'
          OR category ILIKE '%' || $5 || '%'
          OR memory_key ILIKE '%' || $5 || '%'
          OR metadata->'extraction'->>'value' ILIKE '%' || $5 || '%'
        )
      ORDER BY updated_at DESC, created_at DESC, id DESC
      LIMIT $6
    `,
    [
      scope.tenantHashId,
      scope.userHashId,
      normalizedStatus,
      normalizedMemoryKey,
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

export async function restoreMemory(scope: MemoryScope, memoryId: string) {
  if (!hasDatabaseUrl()) {
    return null;
  }

  await ensureMemoryStore();

  const client = await getPostgresPool().connect();

  try {
    await client.query("BEGIN");

    const targetResult = await client.query<MemoryRow>(
      `
        SELECT ${MEMORY_RETURNING_COLUMNS}
        FROM public.assistant_memories
        WHERE tenant_hash_id = $1 AND user_hash_id = $2 AND memory_id = $3
        FOR UPDATE
      `,
      [scope.tenantHashId, scope.userHashId, memoryId],
    );
    const target = targetResult.rows[0];
    if (!target) {
      await client.query("ROLLBACK");
      return null;
    }

    const memoryKey = normalizeMemoryKey(target.memory_key);
    if (memoryKey !== "general") {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1)::bigint)",
        [`memory:${scope.tenantHashId}:${scope.userHashId}:${memoryKey}`],
      );

      await client.query(
        `
          UPDATE public.assistant_memories
          SET
            status = 'superseded',
            valid_to = NOW(),
            superseded_by_memory_id = $4,
            updated_at = NOW()
          WHERE
            tenant_hash_id = $1
            AND user_hash_id = $2
            AND memory_key = $3
            AND memory_id <> $4
            AND status = 'active'
        `,
        [scope.tenantHashId, scope.userHashId, memoryKey, memoryId],
      );
    }

    const restored = await client.query<MemoryRow>(
      `
        UPDATE public.assistant_memories
        SET
          status = 'active',
          valid_from = NOW(),
          valid_to = NULL,
          superseded_by_memory_id = NULL,
          updated_at = NOW()
        WHERE tenant_hash_id = $1 AND user_hash_id = $2 AND memory_id = $3
        RETURNING ${MEMORY_RETURNING_COLUMNS}
      `,
      [scope.tenantHashId, scope.userHashId, memoryId],
    );

    await client.query("COMMIT");
    return rowToStoredMemory(restored.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function previewSaveMemory(
  scope: MemoryScope,
  {
    category,
    content,
  }: {
    category: string;
    content: string;
  },
): Promise<MemorySavePreview | null> {
  if (!hasDatabaseUrl()) {
    return null;
  }

  await ensureMemoryStore();

  const normalizedCategory = category.trim() || "general";
  const normalizedContent = content.trim();
  const extraction = extractMemoryByRules(normalizedCategory, normalizedContent);
  const previewCategory =
    normalizedCategory === "general" ? extraction.category : normalizedCategory;
  const memoryKey = extraction.key;
  if (memoryKey === "general") {
    return {
      category: previewCategory,
      content: normalizedContent,
      extraction,
      memoryKey,
      newValue: extraction.value,
      replacedMemory: null,
      replacedValue: null,
      willReplace: false,
    };
  }

  const result = await getPostgresPool().query<MemoryRow>(
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
    `,
    [scope.tenantHashId, scope.userHashId, memoryKey],
  );
  const replacedMemory = result.rows[0]
    ? rowToStoredMemory(result.rows[0])
    : null;

  return {
    category: previewCategory,
    content: normalizedContent,
    extraction,
    memoryKey,
    newValue: extraction.value,
    replacedMemory,
    replacedValue: replacedMemory?.extraction?.value ?? null,
    willReplace:
      replacedMemory !== null && replacedMemory.content !== normalizedContent,
  };
}

export function formatMemoriesForPrompt(memories: StoredMemory[]) {
  if (memories.length === 0) {
    return null;
  }

  const memoryLines = memories.map((memory, index) => {
    const category = memory.category ? ` [${memory.category}]` : "";
    const extraction = formatMemoryExtractionForPrompt(memory.extraction);
    return `${index + 1}.${category}${extraction} ${memory.content}`;
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
  const metadata = isRecord(row.metadata) ? row.metadata : {};

  return {
    category: row.category,
    content: row.content,
    createdAt: toIsoString(row.created_at),
    extraction: resolveStoredMemoryExtraction(row, metadata),
    memoryId: row.memory_id,
    memoryKey: normalizeMemoryKey(row.memory_key),
    metadata,
    sourceThreadId: row.source_thread_id,
    status: normalizeMemoryStatus(row.status),
    supersededByMemoryId: row.superseded_by_memory_id,
    updatedAt: toIsoString(row.updated_at),
    validFrom: toIsoString(row.valid_from),
    validTo: row.valid_to ? toIsoString(row.valid_to) : null,
  };
}

function normalizeMemoryKey(value: string): MemoryKey {
  return MEMORY_KEYS.find((key) => key === value) ?? "general";
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

function normalizeMemoryCategory(category: string | undefined) {
  return category?.trim() || "general";
}

function extractAnswerLanguage(content: string) {
  const englishIndex = findLastPatternIndex(content, [
    "英文回答",
    "使用英文",
    "用英文",
    "回答用英文",
    "answer in english",
    "respond in english",
    "reply in english",
    "use english",
  ]);
  const chineseIndex = findLastPatternIndex(content, [
    "中文回答",
    "使用中文",
    "用中文",
    "回答用中文",
    "answer in chinese",
    "respond in chinese",
    "reply in chinese",
    "use chinese",
  ]);

  if (englishIndex < 0 && chineseIndex < 0) {
    return null;
  }

  return englishIndex >= chineseIndex ? "english" : "chinese";
}

function extractCurrentLocation(content: string) {
  return extractFirstCleanMatch(content, [
    /(?:用户)?(?:当前)?(?:位置|地点|城市)(?:是|在|为)\s*([^。！？!?，,；;\n]+)/i,
    /(?:当前)?(?:我的|用户的)(?:位置|地点|城市)(?:是|在|为)\s*([^。！？!?，,；;\n]+)/i,
    /(?:我|本人)(?:现在|目前|当前)?(?:在|住在|位于)\s*([^。！？!?，,；;\n]+)/i,
    /(?:current location is|located in|i am in|i live in)\s+([^.,;!?\n]+)/i,
  ]);
}

function extractNickname(content: string) {
  return extractFirstCleanMatch(content, [
    /(?:叫我|称呼我为|称呼我|我的昵称是|我的名字是)\s*([^。！？!?，,；;\n]+)/i,
    /(?:call me|my nickname is|my name is)\s+([^.,;!?\n]+)/i,
  ]);
}

function extractAnswerStyle(content: string) {
  const conciseIndex = findLastPatternIndex(content, [
    "简短",
    "简洁",
    "少废话",
    "短一点",
    "concise",
    "brief",
  ]);
  const detailedIndex = findLastPatternIndex(content, [
    "详细",
    "展开说明",
    "详细一点",
    "detailed",
    "more detail",
  ]);
  const formalIndex = findLastPatternIndex(content, ["正式", "formal"]);
  const casualIndex = findLastPatternIndex(content, [
    "口语",
    "随意",
    "casual",
  ]);

  const candidates = [
    { index: conciseIndex, value: "concise" },
    { index: detailedIndex, value: "detailed" },
    { index: formalIndex, value: "formal" },
    { index: casualIndex, value: "casual" },
  ].filter((candidate) => candidate.index >= 0);

  if (candidates.length === 0) {
    return null;
  }

  return candidates.sort((left, right) => right.index - left.index)[0].value;
}

function findLastPatternIndex(value: string, patterns: string[]) {
  return patterns.reduce((latestIndex, pattern) => {
    const index = value.lastIndexOf(pattern);
    return index > latestIndex ? index : latestIndex;
  }, -1);
}

function extractFirstCleanMatch(value: string, patterns: RegExp[]) {
  for (const pattern of patterns) {
    const match = value.match(pattern);
    const cleanedValue = cleanExtractedValue(match?.[1]);
    if (cleanedValue) {
      return cleanedValue;
    }
  }

  return null;
}

function cleanExtractedValue(value: string | undefined) {
  const cleanedValue = value
    ?.trim()
    .replace(/^[\s:："'“”‘’「」《》]+/, "")
    .replace(/[\s。.!！?？,，;；"'“”‘’「」《》]+$/, "")
    .trim();

  return cleanedValue ? cleanedValue.slice(0, 100) : null;
}

function normalizeMemoryExtraction(
  extraction: MemoryExtraction,
  fallbackCategory: string,
): MemoryExtraction {
  const key = normalizeMemoryKey(extraction.key);
  return {
    category: normalizeMemoryCategory(extraction.category || fallbackCategory),
    confidence: clampConfidence(extraction.confidence),
    key,
    ...(typeof extraction.reason === "string" && extraction.reason.trim()
      ? { reason: extraction.reason.trim() }
      : {}),
    source: extraction.source === "model" ? "model" : "rule",
    value: cleanExtractedValue(extraction.value ?? undefined),
  };
}

function mergeMemoryExtractionMetadata(
  metadata: Record<string, unknown>,
  extraction: MemoryExtraction,
) {
  return {
    ...metadata,
    extraction,
  };
}

function resolveStoredMemoryExtraction(
  row: MemoryRow,
  metadata: Record<string, unknown>,
) {
  const metadataExtraction = parseMemoryExtraction(metadata.extraction);
  if (metadataExtraction) {
    return metadataExtraction;
  }

  const derivedExtraction = extractMemoryByRules(row.category, row.content);
  const memoryKey = normalizeMemoryKey(row.memory_key);
  if (derivedExtraction.key === memoryKey) {
    return derivedExtraction;
  }

  return {
    ...derivedExtraction,
    confidence: Math.min(derivedExtraction.confidence, 0.5),
    key: memoryKey,
    reason: "由历史 memory_key 补全结构化提取信息",
    value: derivedExtraction.value,
  };
}

function parseMemoryExtraction(value: unknown): MemoryExtraction | null {
  if (!isRecord(value)) {
    return null;
  }

  const key = typeof value.key === "string"
    ? normalizeMemoryKey(value.key)
    : "general";
  const category = typeof value.category === "string"
    ? normalizeMemoryCategory(value.category)
    : "general";
  const source = value.source === "model" ? "model" : "rule";
  const confidence = typeof value.confidence === "number"
    ? clampConfidence(value.confidence)
    : 0.5;
  const extraction: MemoryExtraction = {
    category,
    confidence,
    key,
    source,
    value: typeof value.value === "string" ? cleanExtractedValue(value.value) : null,
  };

  if (typeof value.reason === "string" && value.reason.trim()) {
    extraction.reason = value.reason.trim();
  }

  return extraction;
}

function formatMemoryExtractionForPrompt(extraction: MemoryExtraction | null) {
  if (!extraction || !extraction.value) {
    return "";
  }

  return ` (${extraction.key}=${extraction.value})`;
}

function clampConfidence(value: number) {
  if (Number.isNaN(value)) {
    return 0;
  }

  return Math.min(Math.max(value, 0), 1);
}

function includesAny(value: string, patterns: string[]) {
  return patterns.some((pattern) => value.includes(pattern));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
