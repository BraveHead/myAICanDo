import { getPostgresPool, hasDatabaseUrl } from "../postgres";

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

export async function ensureThreadStore() {
  if (!hasDatabaseUrl()) {
    return;
  }

  setupPromise ??= setupAssistantThreadsTable();

  await setupPromise;
}

async function setupAssistantThreadsTable() {
  await getPostgresPool().query(`
    CREATE TABLE IF NOT EXISTS public.assistant_threads (
      id BIGSERIAL PRIMARY KEY,
      thread_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'regular',
      agent_id TEXT,
      repository JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function listThreadRows() {
  if (!hasDatabaseUrl()) {
    return [];
  }

  await ensureThreadStore();

  const result = await getPostgresPool().query<ThreadRow>(`
    SELECT thread_id, title, status, agent_id, repository, created_at, updated_at
    FROM public.assistant_threads
    ORDER BY updated_at DESC
  `);

  return result.rows;
}

export async function createThreadRow(thread: ThreadInput) {
  if (!hasDatabaseUrl()) {
    return;
  }

  await ensureThreadStore();

  await getPostgresPool().query(
    `
      INSERT INTO public.assistant_threads (thread_id, title, status, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (thread_id) DO NOTHING
    `,
    [
      thread.threadId,
      thread.title,
      thread.status,
      thread.createdAt,
      thread.updatedAt,
    ],
  );
}

export async function touchThreadRow({
  threadId,
  title,
  updatedAt,
}: {
  threadId: string;
  title: string;
  updatedAt: string;
}) {
  if (!hasDatabaseUrl()) {
    return;
  }

  await ensureThreadStore();

  await getPostgresPool().query(
    `
      INSERT INTO public.assistant_threads AS assistant_thread (thread_id, title, status, created_at, updated_at)
      VALUES ($1, $2, 'regular', $3, $3)
      ON CONFLICT (thread_id) DO UPDATE
      SET
        title = CASE
          WHEN assistant_thread.title = 'New Chat' THEN EXCLUDED.title
          ELSE assistant_thread.title
        END,
        updated_at = EXCLUDED.updated_at
    `,
    [threadId, title, updatedAt],
  );
}

export async function saveThreadMessagesRow({
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
}) {
  if (!hasDatabaseUrl()) {
    return;
  }

  await ensureThreadStore();

  await getPostgresPool().query(
    `
      INSERT INTO public.assistant_threads AS assistant_thread (
        thread_id,
        title,
        status,
        agent_id,
        repository,
        created_at,
        updated_at
      )
      VALUES ($1, $2, 'regular', $3, $4::jsonb, $5, $5)
      ON CONFLICT (thread_id) DO UPDATE
      SET
        title = EXCLUDED.title,
        status = EXCLUDED.status,
        agent_id = COALESCE(EXCLUDED.agent_id, assistant_thread.agent_id),
        repository = EXCLUDED.repository,
        updated_at = EXCLUDED.updated_at
    `,
    [threadId, title, agentId ?? null, JSON.stringify(repository), updatedAt],
  );
}

export async function getThreadRepositoryJson(threadId: string) {
  if (!hasDatabaseUrl()) {
    return null;
  }

  await ensureThreadStore();

  const result = await getPostgresPool().query<Pick<ThreadRow, "repository">>(
    "SELECT repository FROM public.assistant_threads WHERE thread_id = $1",
    [threadId],
  );

  return result.rows[0]?.repository ?? null;
}

export async function saveThreadRepositoryJson(thread: ThreadInput & {
  repository: unknown;
}) {
  if (!hasDatabaseUrl()) {
    return;
  }

  await ensureThreadStore();

  await getPostgresPool().query(
    `
      INSERT INTO public.assistant_threads (
        thread_id,
        title,
        status,
        repository,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4::jsonb, $5, $6)
      ON CONFLICT (thread_id) DO UPDATE
      SET
        title = EXCLUDED.title,
        status = EXCLUDED.status,
        repository = EXCLUDED.repository,
        updated_at = EXCLUDED.updated_at
    `,
    [
      thread.threadId,
      thread.title,
      thread.status,
      JSON.stringify(thread.repository),
      thread.createdAt,
      thread.updatedAt,
    ],
  );
}

export async function getThreadAgentId(threadId: string) {
  if (!hasDatabaseUrl()) {
    return undefined;
  }

  await ensureThreadStore();

  const result = await getPostgresPool().query<Pick<ThreadRow, "agent_id">>(
    "SELECT agent_id FROM public.assistant_threads WHERE thread_id = $1",
    [threadId],
  );

  return result.rows[0]?.agent_id ?? undefined;
}

export async function saveThreadAgentId({
  agentId,
  threadId,
  updatedAt,
}: {
  agentId: string;
  threadId: string;
  updatedAt: string;
}) {
  if (!hasDatabaseUrl()) {
    return;
  }

  await ensureThreadStore();

  await getPostgresPool().query(
    `
      INSERT INTO public.assistant_threads (thread_id, title, status, agent_id, created_at, updated_at)
      VALUES ($1, 'New Chat', 'regular', $2, $3, $3)
      ON CONFLICT (thread_id) DO UPDATE
      SET agent_id = EXCLUDED.agent_id, updated_at = EXCLUDED.updated_at
    `,
    [threadId, agentId, updatedAt],
  );
}
