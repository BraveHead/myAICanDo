import type { ThreadScope } from "@/lib/server/thread-store/persistence";
import type { TodoInputItem, TodoItem, TodoState, TodoWriteResult } from "./types";

type TodoStateRow = {
  agent_id: string;
  revision: number;
  todos: unknown;
  updated_at: Date | string;
};

type WriteTodoStateOptions = {
  agentId: string;
  threadId: string;
  todos: TodoInputItem[];
};

type TodoErrorResult = Extract<TodoWriteResult, { ok: false }>;

type StoredTodoState = TodoState & {
  threadId: string;
};

type TodoNormalizeResult =
  | {
      ok: true;
      todos: TodoItem[];
    }
  | TodoErrorResult;

const MAX_TODO_COUNT = 20;
const MAX_TODO_CONTENT_LENGTH = 240;
const inMemoryTodoStates = new Map<string, StoredTodoState>();
let setupPromise: Promise<void> | null = null;

export async function getThreadTodoState(
  scope: ThreadScope,
  threadId: string,
): Promise<TodoState | null> {
  if (!hasTodoDatabaseUrl()) {
    return inMemoryTodoStates.get(createTodoStateKey(scope, threadId)) ?? null;
  }

  await ensureTodoStateStore();

  const pool = await getTodoPostgresPool();
  const result = await pool.query<TodoStateRow>(
    `
      SELECT agent_id, todos, revision, updated_at
      FROM public.assistant_thread_todo_states
      WHERE tenant_hash_id = $1 AND user_hash_id = $2 AND thread_id = $3
    `,
    [scope.tenantHashId, scope.userHashId, threadId],
  );

  return result.rows[0] ? rowToTodoState(result.rows[0]) : null;
}

export async function writeThreadTodoState(
  scope: ThreadScope,
  { agentId, threadId, todos }: WriteTodoStateOptions,
): Promise<TodoWriteResult> {
  if (!hasTodoDatabaseUrl()) {
    return writeInMemoryTodoState(scope, {
      agentId,
      threadId,
      todos,
    });
  }

  await ensureTodoStateStore();

  const pool = await getTodoPostgresPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [
      `todos:${scope.tenantHashId}:${scope.userHashId}:${threadId}`,
    ]);

    const existingResult = await client.query<TodoStateRow>(
      `
        SELECT agent_id, todos, revision, updated_at
        FROM public.assistant_thread_todo_states
        WHERE tenant_hash_id = $1 AND user_hash_id = $2 AND thread_id = $3
        FOR UPDATE
      `,
      [scope.tenantHashId, scope.userHashId, threadId],
    );
    const existingState = existingResult.rows[0]
      ? rowToTodoState(existingResult.rows[0])
      : null;
    const normalizedTodos = normalizeTodoInputs(todos, existingState?.todos ?? []);
    if (!normalizedTodos.ok) {
      await client.query("ROLLBACK");
      return normalizedTodos;
    }

    const updatedAt = new Date().toISOString();
    const revision = (existingState?.revision ?? 0) + 1;
    const state = {
      agentId,
      revision,
      todos: normalizedTodos.todos,
      updatedAt,
    } satisfies TodoState;

    await client.query(
      `
        INSERT INTO public.assistant_thread_todo_states (
          tenant_hash_id,
          user_hash_id,
          thread_id,
          agent_id,
          todos,
          revision,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $7)
        ON CONFLICT (tenant_hash_id, user_hash_id, thread_id) DO UPDATE
        SET
          agent_id = EXCLUDED.agent_id,
          todos = EXCLUDED.todos,
          revision = EXCLUDED.revision,
          updated_at = EXCLUDED.updated_at
      `,
      [
        scope.tenantHashId,
        scope.userHashId,
        threadId,
        agentId,
        JSON.stringify(state.todos),
        state.revision,
        state.updatedAt,
      ],
    );
    await client.query("COMMIT");

    return createTodoSuccessResult(state);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function normalizeTodoInputs(
  todos: TodoInputItem[],
  previousTodos: TodoItem[] = [],
): TodoNormalizeResult {
  if (!Array.isArray(todos)) {
    return createTodoError("invalid_todos", "todos 必须是数组。");
  }

  if (todos.length > MAX_TODO_COUNT) {
    return createTodoError(
      "too_many_todos",
      `最多只能维护 ${MAX_TODO_COUNT} 个任务。`,
    );
  }

  const previousByContent = new Map(previousTodos.map((todo) => [todo.content, todo]));
  const usedIds = new Set<string>();
  const normalizedTodos: TodoItem[] = [];
  let inProgressCount = 0;

  for (const todo of todos) {
    const content = normalizeTodoContent(todo.content);
    if (!content) {
      return createTodoError("empty_content", "todo.content 不能为空。");
    }

    if (content.length > MAX_TODO_CONTENT_LENGTH) {
      return createTodoError(
        "content_too_long",
        `todo.content 不能超过 ${MAX_TODO_CONTENT_LENGTH} 个字符。`,
      );
    }

    if (!isTodoStatus(todo.status)) {
      return createTodoError("invalid_status", "todo.status 不合法。");
    }

    if (todo.status === "in_progress") {
      inProgressCount += 1;
    }

    const id = normalizeTodoId(todo.id) ?? previousByContent.get(content)?.id ?? createTodoId();
    if (usedIds.has(id)) {
      return createTodoError("duplicate_id", `todo.id 重复：${id}`);
    }

    usedIds.add(id);
    normalizedTodos.push({
      content,
      id,
      status: todo.status,
    });
  }

  if (inProgressCount > 1) {
    return createTodoError(
      "multiple_in_progress",
      "同一时间最多只能有一个 in_progress 任务。",
    );
  }

  return {
    ok: true,
    todos: normalizedTodos,
  };
}

export function resetInMemoryTodoStatesForTests() {
  inMemoryTodoStates.clear();
}

async function writeInMemoryTodoState(
  scope: ThreadScope,
  { agentId, threadId, todos }: WriteTodoStateOptions,
): Promise<TodoWriteResult> {
  const key = createTodoStateKey(scope, threadId);
  const existingState = inMemoryTodoStates.get(key) ?? null;
  const normalizedTodos = normalizeTodoInputs(todos, existingState?.todos ?? []);
  if (!normalizedTodos.ok) {
    return normalizedTodos;
  }

  const state = {
    agentId,
    revision: (existingState?.revision ?? 0) + 1,
    threadId,
    todos: normalizedTodos.todos,
    updatedAt: new Date().toISOString(),
  } satisfies StoredTodoState;

  inMemoryTodoStates.set(key, state);

  return createTodoSuccessResult(state);
}

async function ensureTodoStateStore() {
  if (!hasTodoDatabaseUrl()) {
    return;
  }

  setupPromise ??= setupAssistantThreadTodoStatesTable();

  await setupPromise;
}

async function setupAssistantThreadTodoStatesTable() {
  const pool = await getTodoPostgresPool();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.assistant_thread_todo_states (
      id BIGSERIAL PRIMARY KEY,
      tenant_hash_id TEXT NOT NULL,
      user_hash_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      todos JSONB NOT NULL DEFAULT '[]'::jsonb,
      revision INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS assistant_thread_todo_states_scope_thread_idx
    ON public.assistant_thread_todo_states (
      tenant_hash_id,
      user_hash_id,
      thread_id
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS assistant_thread_todo_states_updated_idx
    ON public.assistant_thread_todo_states (updated_at DESC)
  `);
}

function rowToTodoState(row: TodoStateRow): TodoState {
  return {
    agentId: row.agent_id,
    revision: row.revision,
    todos: parseStoredTodos(row.todos),
    updatedAt: toIsoString(row.updated_at),
  };
}

function parseStoredTodos(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }

    const candidate = item as Partial<TodoItem>;
    const content = normalizeTodoContent(candidate.content);
    const id = normalizeTodoId(candidate.id);
    if (!content || !id || !isTodoStatus(candidate.status)) {
      return [];
    }

    return [
      {
        content,
        id,
        status: candidate.status,
      },
    ];
  });
}

function createTodoSuccessResult(state: TodoState): TodoWriteResult {
  const completedCount = state.todos.filter(
    (todo) => todo.status === "completed",
  ).length;

  return {
    ok: true,
    state,
    summary:
      state.todos.length === 0
        ? "已清空任务列表。"
        : `已更新 ${state.todos.length} 个任务，${completedCount} 个已完成。`,
  };
}

function createTodoError(code: string, message: string): TodoErrorResult {
  return {
    error: {
      code,
      message,
    },
    ok: false,
    summary: message,
  };
}

function createTodoStateKey(scope: ThreadScope, threadId: string) {
  return `${scope.tenantHashId}:${scope.userHashId}:${threadId}`;
}

async function getTodoPostgresPool() {
  const { getPostgresPool } = await import("@/lib/server/postgres");
  return getPostgresPool();
}

function hasTodoDatabaseUrl() {
  return Boolean(process.env.DATABASE_URL?.trim());
}

function createTodoId() {
  return `todo_${crypto.randomUUID()}`;
}

function normalizeTodoId(id: unknown) {
  if (typeof id !== "string") {
    return undefined;
  }

  const normalizedId = id.trim();
  return normalizedId ? normalizedId.slice(0, 120) : undefined;
}

function normalizeTodoContent(content: unknown) {
  return typeof content === "string" ? content.replace(/\s+/g, " ").trim() : "";
}

function isTodoStatus(status: unknown): status is TodoItem["status"] {
  return (
    status === "pending" ||
    status === "in_progress" ||
    status === "completed"
  );
}

function toIsoString(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
