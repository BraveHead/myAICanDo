import { getPostgresPool, hasDatabaseUrl } from "../postgres";

export type ThreadScope = {
  tenantHashId: string;
  userHashId: string;
};

export type ThreadRow = {
  thread_id: string;
  title: string;
  status: "regular";
  agent_id: string | null;
  repository: unknown;
  created_at: Date | string;
  updated_at: Date | string;
};

type ThreadInput = {
  createdAt: string;
  status: ThreadRow["status"];
  threadId: string;
  title: string;
  updatedAt: string;
};

let setupPromise: Promise<void> | null = null;

async function ensureThreadStore() {
  if (!hasDatabaseUrl()) {
    return;
  }

  setupPromise ??= setupAssistantThreadsTable();

  await setupPromise;
}

async function setupAssistantThreadsTable() {
  const pool = getPostgresPool();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.assistant_threads (
      id BIGSERIAL PRIMARY KEY,
      tenant_hash_id TEXT NOT NULL,
      user_hash_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'regular',
      agent_id TEXT,
      repository JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    ALTER TABLE public.assistant_threads
    ADD COLUMN IF NOT EXISTS tenant_hash_id TEXT
  `);
  await pool.query(`
    ALTER TABLE public.assistant_threads
    ADD COLUMN IF NOT EXISTS user_hash_id TEXT
  `);
  await pool.query(`
    ALTER TABLE public.assistant_threads
    DROP CONSTRAINT IF EXISTS assistant_threads_thread_id_key
  `);
  await pool.query(`
    DROP INDEX IF EXISTS public.assistant_threads_thread_id_key
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS assistant_threads_scope_thread_idx
    ON public.assistant_threads (tenant_hash_id, user_hash_id, thread_id)
  `);
}

export async function listThreadRows(scope: ThreadScope) {
  if (!hasDatabaseUrl()) {
    return [];
  }

  await ensureThreadStore();

  const result = await getPostgresPool().query<ThreadRow>(
    `
      SELECT thread_id, title, status, agent_id, repository, created_at, updated_at
      FROM public.assistant_threads
      WHERE tenant_hash_id = $1 AND user_hash_id = $2
      ORDER BY updated_at DESC
    `,
    [scope.tenantHashId, scope.userHashId],
  );

  return result.rows;
}

export async function createThreadRow(scope: ThreadScope, thread: ThreadInput) {
  if (!hasDatabaseUrl()) {
    return;
  }

  await ensureThreadStore();

  await getPostgresPool().query(
    `
      INSERT INTO public.assistant_threads (
        tenant_hash_id,
        user_hash_id,
        thread_id,
        title,
        status,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (tenant_hash_id, user_hash_id, thread_id) DO NOTHING
    `,
    [
      scope.tenantHashId,
      scope.userHashId,
      thread.threadId,
      thread.title,
      thread.status,
      thread.createdAt,
      thread.updatedAt,
    ],
  );
}

export async function touchThreadRow(
  scope: ThreadScope,
  {
    threadId,
    title,
    updatedAt,
  }: {
    threadId: string;
    title: string;
    updatedAt: string;
  },
) {
  if (!hasDatabaseUrl()) {
    return;
  }

  await ensureThreadStore();

  await getPostgresPool().query(
    `
      INSERT INTO public.assistant_threads AS assistant_thread (
        tenant_hash_id,
        user_hash_id,
        thread_id,
        title,
        status,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, 'regular', $5, $5)
      ON CONFLICT (tenant_hash_id, user_hash_id, thread_id) DO UPDATE
      SET
        title = CASE
          WHEN assistant_thread.title = 'New Chat' THEN EXCLUDED.title
          ELSE assistant_thread.title
        END,
        updated_at = EXCLUDED.updated_at
    `,
    [scope.tenantHashId, scope.userHashId, threadId, title, updatedAt],
  );
}

export async function saveThreadMessagesRow(
  scope: ThreadScope,
  {
    agentId,
    repository,
    threadId,
    title,
    updatedAt,
  }: {
    agentId?: string | null;
    repository: unknown;
    threadId: string;
    title: string;
    updatedAt: string;
  },
) {
  if (!hasDatabaseUrl()) {
    return;
  }

  await ensureThreadStore();

  await getPostgresPool().query(
    `
      INSERT INTO public.assistant_threads AS assistant_thread (
        tenant_hash_id,
        user_hash_id,
        thread_id,
        title,
        status,
        agent_id,
        repository,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, 'regular', $5, $6::jsonb, $7, $7)
      ON CONFLICT (tenant_hash_id, user_hash_id, thread_id) DO UPDATE
      SET
        title = EXCLUDED.title,
        status = EXCLUDED.status,
        agent_id = COALESCE(EXCLUDED.agent_id, assistant_thread.agent_id),
        repository = EXCLUDED.repository,
        updated_at = EXCLUDED.updated_at
    `,
    [
      scope.tenantHashId,
      scope.userHashId,
      threadId,
      title,
      agentId ?? null,
      JSON.stringify(repository),
      updatedAt,
    ],
  );
}

export async function getThreadRepositoryJson(
  scope: ThreadScope,
  threadId: string,
) {
  if (!hasDatabaseUrl()) {
    return null;
  }

  await ensureThreadStore();

  const result = await getPostgresPool().query<Pick<ThreadRow, "repository">>(
    `
      SELECT repository
      FROM public.assistant_threads
      WHERE tenant_hash_id = $1 AND user_hash_id = $2 AND thread_id = $3
    `,
    [scope.tenantHashId, scope.userHashId, threadId],
  );

  return result.rows[0]?.repository ?? null;
}

export async function saveThreadRepositoryJson(
  scope: ThreadScope,
  thread: ThreadInput & {
    repository: unknown;
  },
) {
  if (!hasDatabaseUrl()) {
    return;
  }

  await ensureThreadStore();

  await getPostgresPool().query(
    `
      INSERT INTO public.assistant_threads (
        tenant_hash_id,
        user_hash_id,
        thread_id,
        title,
        status,
        repository,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
      ON CONFLICT (tenant_hash_id, user_hash_id, thread_id) DO UPDATE
      SET
        title = EXCLUDED.title,
        status = EXCLUDED.status,
        repository = EXCLUDED.repository,
        updated_at = EXCLUDED.updated_at
    `,
    [
      scope.tenantHashId,
      scope.userHashId,
      thread.threadId,
      thread.title,
      thread.status,
      JSON.stringify(thread.repository),
      thread.createdAt,
      thread.updatedAt,
    ],
  );
}

export async function getThreadAgentId(scope: ThreadScope, threadId: string) {
  if (!hasDatabaseUrl()) {
    return undefined;
  }

  await ensureThreadStore();

  const result = await getPostgresPool().query<Pick<ThreadRow, "agent_id">>(
    `
      SELECT agent_id
      FROM public.assistant_threads
      WHERE tenant_hash_id = $1 AND user_hash_id = $2 AND thread_id = $3
    `,
    [scope.tenantHashId, scope.userHashId, threadId],
  );

  return result.rows[0]?.agent_id ?? undefined;
}

export async function saveThreadAgentId(
  scope: ThreadScope,
  {
    agentId,
    threadId,
    updatedAt,
  }: {
    agentId: string;
    threadId: string;
    updatedAt: string;
  },
) {
  if (!hasDatabaseUrl()) {
    return;
  }

  await ensureThreadStore();

  await getPostgresPool().query(
    `
      INSERT INTO public.assistant_threads (
        tenant_hash_id,
        user_hash_id,
        thread_id,
        title,
        status,
        agent_id,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, 'New Chat', 'regular', $4, $5, $5)
      ON CONFLICT (tenant_hash_id, user_hash_id, thread_id) DO UPDATE
      SET agent_id = EXCLUDED.agent_id, updated_at = EXCLUDED.updated_at
    `,
    [scope.tenantHashId, scope.userHashId, threadId, agentId, updatedAt],
  );
}
