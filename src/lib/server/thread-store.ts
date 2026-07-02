import type { ExportedMessageRepository } from "@assistant-ui/react";
import type { AgentMessage } from "@/lib/agent/core/agent-definition";
import type { SupportedAgent } from "@/lib/agent/shared/agent-ids";
import { isSupportedAgent } from "@/lib/agent/shared/agent-ids";
import type { StoredThread } from "@/lib/thread-types";
import { getPostgresPool, hasDatabaseUrl } from "./postgres";

type ThreadRow = {
  id: string;
  title: string;
  status: "regular";
  agent_id: string | null;
  repository: unknown;
  created_at: Date | string;
  updated_at: Date | string;
};

let setupPromise: Promise<void> | null = null;

export async function ensureThreadStore() {
  if (!hasDatabaseUrl()) {
    return;
  }

  setupPromise ??= getPostgresPool().query(`
    CREATE TABLE IF NOT EXISTS assistant_threads (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'regular',
      agent_id TEXT,
      repository JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).then(() => undefined);

  await setupPromise;
}

export async function listStoredThreads() {
  if (!hasDatabaseUrl()) {
    return [];
  }

  await ensureThreadStore();

  const result = await getPostgresPool().query<ThreadRow>(`
    SELECT id, title, status, agent_id, repository, created_at, updated_at
    FROM assistant_threads
    ORDER BY updated_at DESC
  `);

  return result.rows.map(toStoredThread);
}

export async function upsertStoredThreads(threads: StoredThread[]) {
  if (!hasDatabaseUrl() || threads.length === 0) {
    return;
  }

  await ensureThreadStore();

  const pool = getPostgresPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    for (const thread of threads) {
      await client.query(
        `
          INSERT INTO assistant_threads (id, title, status, created_at, updated_at)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (id) DO UPDATE
          SET
            title = EXCLUDED.title,
            status = EXCLUDED.status,
            updated_at = EXCLUDED.updated_at
        `,
        [
          thread.id,
          thread.title,
          thread.status,
          thread.createdAt,
          thread.updatedAt,
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function touchThreadFromMessages(
  threadId: string,
  messages: AgentMessage[],
) {
  if (!hasDatabaseUrl()) {
    return;
  }

  await ensureThreadStore();

  const title = getTitleFromAgentMessages(messages);
  const now = new Date().toISOString();

  await getPostgresPool().query(
    `
      INSERT INTO assistant_threads (id, title, status, created_at, updated_at)
      VALUES ($1, $2, 'regular', $3, $3)
      ON CONFLICT (id) DO UPDATE
      SET
        title = CASE
          WHEN assistant_threads.title = 'New Chat' THEN EXCLUDED.title
          ELSE assistant_threads.title
        END,
        updated_at = EXCLUDED.updated_at
    `,
    [threadId, title, now],
  );
}

export async function getThreadRepository(threadId: string) {
  if (!hasDatabaseUrl()) {
    return null;
  }

  await ensureThreadStore();

  const result = await getPostgresPool().query<Pick<ThreadRow, "repository">>(
    "SELECT repository FROM assistant_threads WHERE id = $1",
    [threadId],
  );

  return (result.rows[0]?.repository as ExportedMessageRepository | null) ?? null;
}

export async function saveThreadRepository({
  thread,
  threadId,
  repository,
}: {
  thread?: StoredThread;
  threadId: string;
  repository: ExportedMessageRepository;
}) {
  if (!hasDatabaseUrl()) {
    return;
  }

  await ensureThreadStore();

  const fallbackThread = createThreadFromRepository(threadId, repository);
  const nextThread = thread ?? fallbackThread;

  await getPostgresPool().query(
    `
      INSERT INTO assistant_threads (
        id,
        title,
        status,
        repository,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, $4::jsonb, $5, $6)
      ON CONFLICT (id) DO UPDATE
      SET
        title = EXCLUDED.title,
        status = EXCLUDED.status,
        repository = EXCLUDED.repository,
        updated_at = EXCLUDED.updated_at
    `,
    [
      nextThread.id,
      nextThread.title,
      nextThread.status,
      JSON.stringify(repository),
      nextThread.createdAt,
      nextThread.updatedAt,
    ],
  );
}

export async function getThreadAgent(threadId: string) {
  if (!hasDatabaseUrl()) {
    return undefined;
  }

  await ensureThreadStore();

  const result = await getPostgresPool().query<Pick<ThreadRow, "agent_id">>(
    "SELECT agent_id FROM assistant_threads WHERE id = $1",
    [threadId],
  );

  const agent = result.rows[0]?.agent_id;
  return isSupportedAgent(agent) ? agent : undefined;
}

export async function saveThreadAgent(
  threadId: string,
  agent: SupportedAgent,
) {
  if (!hasDatabaseUrl()) {
    return;
  }

  await ensureThreadStore();

  const now = new Date().toISOString();
  await getPostgresPool().query(
    `
      INSERT INTO assistant_threads (id, title, status, agent_id, created_at, updated_at)
      VALUES ($1, 'New Chat', 'regular', $2, $3, $3)
      ON CONFLICT (id) DO UPDATE
      SET agent_id = EXCLUDED.agent_id, updated_at = EXCLUDED.updated_at
    `,
    [threadId, agent, now],
  );
}

export async function loadThreadAgentMessages(threadId: string) {
  const repository = await getThreadRepository(threadId);
  if (!repository) {
    return [];
  }

  return repositoryToAgentMessages(repository);
}

export function mergeAgentMessages(
  storedMessages: AgentMessage[],
  incomingMessages: AgentMessage[],
) {
  const merged = [...storedMessages];

  for (const message of incomingMessages) {
    const lastMessage = merged.at(-1);
    if (
      lastMessage?.role === message.role &&
      lastMessage.content === message.content
    ) {
      continue;
    }

    merged.push(message);
  }

  return merged;
}

function toStoredThread(row: ThreadRow): StoredThread {
  return {
    id: row.id,
    title: row.title,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    status: row.status,
  };
}

function createThreadFromRepository(
  threadId: string,
  repository: ExportedMessageRepository,
): StoredThread {
  const now = new Date().toISOString();
  const messages = repositoryToAgentMessages(repository);

  return {
    id: threadId,
    title: getTitleFromAgentMessages(messages),
    createdAt: now,
    updatedAt: now,
    status: "regular",
  };
}

function repositoryToAgentMessages(repository: ExportedMessageRepository) {
  if (!Array.isArray(repository.messages)) {
    return [];
  }

  return repository.messages.flatMap((item) => {
    const message = item.message;
    if (
      message.role !== "system" &&
      message.role !== "user" &&
      message.role !== "assistant"
    ) {
      return [];
    }

    const content = message.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n")
      .trim();

    if (!content) {
      return [];
    }

    return [
      {
        role: message.role,
        content,
      } satisfies AgentMessage,
    ];
  });
}

function getTitleFromAgentMessages(messages: AgentMessage[]) {
  const firstUserText =
    messages.find((message) => message.role === "user")?.content.trim() ?? "";

  if (!firstUserText) {
    return "New Chat";
  }

  return firstUserText.length > 34
    ? `${firstUserText.slice(0, 34).trim()}...`
    : firstUserText;
}

function toIsoString(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
