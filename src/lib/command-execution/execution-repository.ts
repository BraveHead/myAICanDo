import type { PoolClient } from "pg";
import type {
  ApprovalExecutionResponse,
  ApprovalGatedToolName,
} from "@/lib/approval-actions";
import type {
  CommandExecutionResult,
  SandboxOutputChunk,
} from "./contracts";
import {
  COMMAND_EXECUTION_MAX_ATTEMPTS,
  isCommandExecutionTerminalStatus,
  type CommandExecutionEvent,
  type CommandExecutionSnapshot,
  type CommandExecutionTaskStatus,
  type PersistedCommandExecutionEvent,
} from "./contracts";
import {
  getPostgresPool,
  hasDatabaseUrl,
} from "@/lib/server/postgres-runtime";
import type { PendingActionScope } from "@/lib/server/pending-action-store";

const WORKER_HEALTH_WINDOW_MS = 15_000;
const EXECUTION_LEASE_MS = 15_000;
const QUEUE_TTL_MS = 30 * 60 * 1000;
const EVENT_RETENTION_DAYS = 7;
const EXECUTION_RETENTION_DAYS = 30;

type ExecutionRow = {
  agent_id: string;
  approval_id: string;
  args: unknown;
  attempt: number;
  backend: CommandExecutionResult["backend"] | null;
  cancel_requested_at: Date | string | null;
  command: string;
  created_at: Date | string;
  cwd: string;
  execution_id: string;
  failure_code: string | null;
  finished_at: Date | string | null;
  last_event_id: string | number | bigint | null;
  lease_expires_at: Date | string | null;
  max_attempts: number;
  output_truncated: boolean;
  parent_execution_id: string | null;
  result: unknown;
  root_execution_id: string;
  started_at: Date | string | null;
  status: CommandExecutionTaskStatus;
  stderr: string | null;
  stdout: string | null;
  summary: string | null;
  thread_id: string;
  timeout_ms: number;
  tool_call_id: string;
  updated_at: Date | string;
  workspace_id: string;
};

type EventRow = {
  created_at: Date | string;
  id: string | number | bigint;
  payload: unknown;
};

type PendingCommandRow = {
  action_id: string;
  agent_id: string;
  args: unknown;
  expires_at: Date | string;
  result: unknown;
  status: string;
  thread_id: string;
  tool_call_id: string;
  tool_name: ApprovalGatedToolName;
};

export type ClaimedCommandExecution = CommandExecutionSnapshot & {
  tenantHashId: string;
  userHashId: string;
  workerId: string;
};

export class CommandExecutionStoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

let setupPromise: Promise<void> | null = null;

export function hasCommandExecutionStore() {
  return hasDatabaseUrl();
}

export async function ensureCommandExecutionStore() {
  if (!hasDatabaseUrl()) {
    throw new CommandExecutionStoreError(
      "execution_store_unavailable",
      "未配置 DATABASE_URL，无法使用持久命令执行。",
      500,
    );
  }
  setupPromise ??= setupCommandExecutionTables();
  await setupPromise;
}

export async function hasHealthyCommandWorker() {
  await ensureCommandExecutionStore();
  const result = await getPostgresPool().query<{ healthy: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM public.assistant_command_worker_heartbeats
        WHERE last_heartbeat_at > NOW() - ($1::int * INTERVAL '1 millisecond')
      ) AS healthy
    `,
    [WORKER_HEALTH_WINDOW_MS],
  );
  return result.rows[0]?.healthy === true;
}

export async function enqueueApprovedCommandExecution(
  scope: PendingActionScope,
  {
    actionId,
    reason,
    threadId,
  }: {
    actionId: string;
    reason?: string;
    threadId: string;
  },
) {
  await ensureCommandExecutionStore();
  const client = await getPostgresPool().connect();
  try {
    await client.query("BEGIN");
    const actionResult = await client.query<PendingCommandRow>(
      `
        SELECT
          action_id,
          agent_id,
          args,
          expires_at,
          result,
          status,
          thread_id,
          tool_call_id,
          tool_name
        FROM public.assistant_pending_actions
        WHERE tenant_hash_id = $1
          AND user_hash_id = $2
          AND workspace_id = $3
          AND thread_id = $4
          AND action_id = $5
        FOR UPDATE
      `,
      [
        scope.tenantHashId,
        scope.userHashId,
        scope.workspaceId,
        threadId,
        actionId,
      ],
    );
    const action = actionResult.rows[0];
    if (!action || action.tool_name !== "execute_command") {
      throw new CommandExecutionStoreError(
        "approval_not_found",
        "命令确认请求不存在或不属于当前作用域。",
        404,
      );
    }

    const existing = await selectExecution(client, scope, {
      approvalId: actionId,
      threadId,
    });
    if (existing) {
      await client.query("COMMIT");
      return existing;
    }
    await assertHealthyWorker(client);
    if (new Date(action.expires_at).getTime() <= Date.now()) {
      throw new CommandExecutionStoreError(
        "approval_expired",
        "命令确认已过期，请重新发起。",
      );
    }
    if (!["pending", "approved", "executing"].includes(action.status)) {
      throw new CommandExecutionStoreError(
        "approval_not_pending",
        `确认请求当前状态为 ${action.status}，不能执行。`,
      );
    }

    const args = toCommandArgs(action.args);
    const executionId = `exec:${crypto.randomUUID()}`;
    await client.query(
      `
        UPDATE public.assistant_pending_actions
        SET status = 'executing',
            decided_at = COALESCE(decided_at, NOW()),
            execution_started_at = COALESCE(execution_started_at, NOW()),
            reason = COALESCE($6, reason)
        WHERE tenant_hash_id = $1
          AND user_hash_id = $2
          AND workspace_id = $3
          AND thread_id = $4
          AND action_id = $5
      `,
      [
        scope.tenantHashId,
        scope.userHashId,
        scope.workspaceId,
        threadId,
        actionId,
        reason ?? null,
      ],
    );
    await client.query(
      `
        INSERT INTO public.assistant_command_executions (
          tenant_hash_id,
          user_hash_id,
          workspace_id,
          thread_id,
          execution_id,
          approval_id,
          tool_call_id,
          agent_id,
          command,
          args,
          cwd,
          timeout_ms,
          status,
          attempt,
          max_attempts,
          root_execution_id,
          queue_expires_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12,
          'queued', 1, $13, $5, $14
        )
      `,
      [
        scope.tenantHashId,
        scope.userHashId,
        scope.workspaceId,
        threadId,
        executionId,
        actionId,
        action.tool_call_id,
        action.agent_id,
        args.command,
        JSON.stringify(args.args),
        args.cwd,
        args.timeoutMs,
        COMMAND_EXECUTION_MAX_ATTEMPTS,
        new Date(Date.now() + QUEUE_TTL_MS),
      ],
    );
    let snapshot = await selectExecution(client, scope, {
      executionId,
      threadId,
    });
    if (!snapshot) {
      throw new Error("创建命令执行任务后无法读取任务。");
    }
    const lastEventId = await appendEvent(client, executionId, {
      execution: snapshot,
      type: "command_state",
    });
    snapshot = {
      ...snapshot,
      lastEventId,
    };
    await client.query("COMMIT");
    return snapshot;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listCommandExecutions(
  scope: PendingActionScope,
  threadId: string,
) {
  await ensureCommandExecutionStore();
  const result = await getPostgresPool().query<ExecutionRow>(
    `${executionSelectSql()}
     WHERE execution.tenant_hash_id = $1
       AND execution.user_hash_id = $2
       AND execution.workspace_id = $3
       AND execution.thread_id = $4
     ORDER BY execution.created_at DESC
     LIMIT 100`,
    [scope.tenantHashId, scope.userHashId, scope.workspaceId, threadId],
  );
  return result.rows.map(rowToSnapshot);
}

export async function getCommandExecution(
  scope: PendingActionScope,
  threadId: string,
  executionId: string,
) {
  await ensureCommandExecutionStore();
  return selectExecution(getPostgresPool(), scope, { executionId, threadId });
}

export async function listCommandExecutionEvents(
  scope: PendingActionScope,
  {
    afterEventId,
    executionId,
    limit = 100,
    threadId,
  }: {
    afterEventId: string;
    executionId: string;
    limit?: number;
    threadId: string;
  },
) {
  await ensureCommandExecutionStore();
  const result = await getPostgresPool().query<EventRow>(
    `
      SELECT event.id, event.payload, event.created_at
      FROM public.assistant_command_execution_events AS event
      INNER JOIN public.assistant_command_executions AS execution
        ON execution.execution_id = event.execution_id
      WHERE execution.tenant_hash_id = $1
        AND execution.user_hash_id = $2
        AND execution.workspace_id = $3
        AND execution.thread_id = $4
        AND execution.execution_id = $5
        AND event.id > $6::bigint
      ORDER BY event.id ASC
      LIMIT $7
    `,
    [
      scope.tenantHashId,
      scope.userHashId,
      scope.workspaceId,
      threadId,
      executionId,
      afterEventId,
      Math.min(500, Math.max(1, limit)),
    ],
  );
  return result.rows.flatMap((row) => {
    const event = toExecutionEvent(row.payload);
    return event
      ? [
          {
            createdAt: toIsoString(row.created_at),
            event,
            id: String(row.id),
          } satisfies PersistedCommandExecutionEvent,
        ]
      : [];
  });
}

export async function requestCommandExecutionCancel(
  scope: PendingActionScope,
  threadId: string,
  executionId: string,
) {
  await ensureCommandExecutionStore();
  const client = await getPostgresPool().connect();
  try {
    await client.query("BEGIN");
    const current = await selectExecution(client, scope, {
      executionId,
      threadId,
      forUpdate: true,
    });
    if (!current) {
      throw new CommandExecutionStoreError(
        "execution_not_found",
        "命令执行任务不存在或不属于当前作用域。",
        404,
      );
    }
    if (isCommandExecutionTerminalStatus(current.status)) {
      await client.query("COMMIT");
      return current;
    }

    if (current.status === "queued") {
      const result = createCancelledResult(current);
      await client.query(
        `
          UPDATE public.assistant_command_executions
          SET status = 'cancelled',
              cancel_requested_at = NOW(),
              finished_at = NOW(),
              result = $2::jsonb,
              summary = $3,
              updated_at = NOW()
          WHERE execution_id = $1
        `,
        [executionId, JSON.stringify(result), result.summary],
      );
    } else {
      await client.query(
        `
          UPDATE public.assistant_command_executions
          SET status = 'cancel_requested',
              cancel_requested_at = COALESCE(cancel_requested_at, NOW()),
              updated_at = NOW()
          WHERE execution_id = $1
            AND status IN ('running', 'cancel_requested')
        `,
        [executionId],
      );
    }

    const snapshot = (await selectExecution(client, scope, {
      executionId,
      threadId,
    }))!;
    let lastEventId: string;
    if (snapshot.status === "cancelled" && snapshot.result) {
      lastEventId = await appendEvent(client, executionId, {
        execution: snapshot,
        result: snapshot.result,
        type: "command_result",
      });
      await updatePendingActionFromExecution(
        client,
        snapshot,
        snapshot.result,
      );
    } else {
      lastEventId = await appendEvent(client, executionId, {
        execution: snapshot,
        type: "command_state",
      });
    }
    const updated = {
      ...snapshot,
      lastEventId,
    };
    await client.query("COMMIT");
    return updated;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function retryCommandExecution(
  scope: PendingActionScope,
  {
    executionId,
    threadId,
  }: {
    executionId: string;
    threadId: string;
  },
) {
  await ensureCommandExecutionStore();
  const client = await getPostgresPool().connect();
  try {
    await client.query("BEGIN");
    await assertHealthyWorker(client);
    const current = await selectExecution(client, scope, {
      executionId,
      threadId,
      forUpdate: true,
    });
    if (!current) {
      throw new CommandExecutionStoreError(
        "execution_not_found",
        "命令执行任务不存在或不属于当前作用域。",
        404,
      );
    }
    if (!isCommandExecutionTerminalStatus(current.status)) {
      throw new CommandExecutionStoreError(
        "execution_not_terminal",
        "命令仍在执行，不能创建重试任务。",
      );
    }
    if (current.status === "completed") {
      throw new CommandExecutionStoreError(
        "execution_already_completed",
        "已完成的命令无需重试。",
      );
    }
    if (current.attempt >= current.maxAttempts) {
      throw new CommandExecutionStoreError(
        "execution_retry_limit_reached",
        `最多允许 ${current.maxAttempts} 次执行。`,
      );
    }

    const existing = await selectExecutionByRootAttempt(
      client,
      scope,
      current.threadId,
      current.rootExecutionId,
      current.attempt + 1,
    );
    if (existing) {
      await client.query("COMMIT");
      return existing;
    }

    const nextExecutionId = `exec:${crypto.randomUUID()}`;
    await client.query(
      `
        INSERT INTO public.assistant_command_executions (
          tenant_hash_id,
          user_hash_id,
          workspace_id,
          thread_id,
          execution_id,
          approval_id,
          tool_call_id,
          agent_id,
          command,
          args,
          cwd,
          timeout_ms,
          status,
          attempt,
          max_attempts,
          root_execution_id,
          parent_execution_id,
          queue_expires_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12,
          'queued', $13, $14, $15, $16, $17
        )
      `,
      [
        scope.tenantHashId,
        scope.userHashId,
        scope.workspaceId,
        threadId,
        nextExecutionId,
        current.approvalId,
        current.toolCallId,
        current.agentId,
        current.command,
        JSON.stringify(current.args),
        current.cwd,
        current.timeoutMs,
        current.attempt + 1,
        current.maxAttempts,
        current.rootExecutionId,
        current.executionId,
        new Date(Date.now() + QUEUE_TTL_MS),
      ],
    );
    await client.query(
      `
        UPDATE public.assistant_pending_actions
        SET status = 'executing',
            result = NULL,
            execution_started_at = NOW()
        WHERE tenant_hash_id = $1
          AND user_hash_id = $2
          AND workspace_id = $3
          AND thread_id = $4
          AND action_id = $5
      `,
      [
        scope.tenantHashId,
        scope.userHashId,
        scope.workspaceId,
        threadId,
        current.approvalId,
      ],
    );
    let next = (await selectExecution(client, scope, {
      executionId: nextExecutionId,
      threadId,
    }))!;
    const lastEventId = await appendEvent(client, nextExecutionId, {
      execution: next,
      type: "command_state",
    });
    next = {
      ...next,
      lastEventId,
    };
    await client.query("COMMIT");
    return next;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function registerCommandWorker(
  workerId: string,
  concurrency: number,
) {
  await ensureCommandExecutionStore();
  await getPostgresPool().query(
    `
      INSERT INTO public.assistant_command_worker_heartbeats (
        worker_id,
        concurrency,
        started_at,
        last_heartbeat_at
      )
      VALUES ($1, $2, NOW(), NOW())
      ON CONFLICT (worker_id)
      DO UPDATE SET
        concurrency = EXCLUDED.concurrency,
        started_at = NOW(),
        last_heartbeat_at = NOW()
    `,
    [workerId, concurrency],
  );
}

export async function heartbeatCommandWorker(workerId: string) {
  await ensureCommandExecutionStore();
  await getPostgresPool().query(
    `
      UPDATE public.assistant_command_worker_heartbeats
      SET last_heartbeat_at = NOW()
      WHERE worker_id = $1
    `,
    [workerId],
  );
}

export async function unregisterCommandWorker(workerId: string) {
  await ensureCommandExecutionStore();
  await getPostgresPool().query(
    `DELETE FROM public.assistant_command_worker_heartbeats WHERE worker_id = $1`,
    [workerId],
  );
}

export async function claimNextCommandExecution(workerId: string) {
  await ensureCommandExecutionStore();
  const client = await getPostgresPool().connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{
      execution_id: string;
      tenant_hash_id: string;
      thread_id: string;
      user_hash_id: string;
      workspace_id: string;
    }>(
      `
        SELECT
          execution_id,
          tenant_hash_id,
          user_hash_id,
          workspace_id,
          thread_id
        FROM public.assistant_command_executions
        WHERE status = 'queued'
          AND queue_expires_at > NOW()
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `,
    );
    const target = result.rows[0];
    if (!target) {
      await client.query("COMMIT");
      return null;
    }
    await client.query(
      `
        UPDATE public.assistant_command_executions
        SET status = 'running',
            worker_id = $2,
            started_at = COALESCE(started_at, NOW()),
            lease_expires_at = NOW() + ($3::int * INTERVAL '1 millisecond'),
            updated_at = NOW()
        WHERE execution_id = $1
      `,
      [target.execution_id, workerId, EXECUTION_LEASE_MS],
    );
    const scope = {
      tenantHashId: target.tenant_hash_id,
      userHashId: target.user_hash_id,
      workspaceId: target.workspace_id,
    };
    let snapshot = (await selectExecution(client, scope, {
      executionId: target.execution_id,
      threadId: target.thread_id,
    }))!;
    const lastEventId = await appendEvent(client, target.execution_id, {
      execution: snapshot,
      type: "command_state",
    });
    snapshot = {
      ...snapshot,
      lastEventId,
    };
    await client.query("COMMIT");
    return {
      ...snapshot,
      tenantHashId: target.tenant_hash_id,
      userHashId: target.user_hash_id,
      workerId,
    } satisfies ClaimedCommandExecution;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function renewCommandExecutionLease(
  workerId: string,
  executionId: string,
) {
  await ensureCommandExecutionStore();
  const result = await getPostgresPool().query(
    `
      UPDATE public.assistant_command_executions
      SET lease_expires_at = NOW() + ($3::int * INTERVAL '1 millisecond'),
          updated_at = NOW()
      WHERE execution_id = $1
        AND worker_id = $2
        AND status IN ('running', 'cancel_requested')
    `,
    [executionId, workerId, EXECUTION_LEASE_MS],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function isCommandExecutionCancelRequested(
  workerId: string,
  executionId: string,
) {
  await ensureCommandExecutionStore();
  const result = await getPostgresPool().query<{ status: string }>(
    `
      SELECT status
      FROM public.assistant_command_executions
      WHERE execution_id = $1
        AND worker_id = $2
      LIMIT 1
    `,
    [executionId, workerId],
  );
  return result.rows[0]?.status === "cancel_requested";
}

export async function appendCommandOutput(
  executionId: string,
  chunk: SandboxOutputChunk,
) {
  await ensureCommandExecutionStore();
  const client = await getPostgresPool().connect();
  try {
    await client.query("BEGIN");
    await appendEvent(client, executionId, {
      executionId,
      ...chunk,
      type: "command_output",
    });
    await client.query(
      `
        UPDATE public.assistant_command_executions
        SET updated_at = NOW()
        WHERE execution_id = $1
          AND status IN ('running', 'cancel_requested')
      `,
      [executionId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function finalizeCommandExecution(
  execution: ClaimedCommandExecution,
  result: CommandExecutionResult,
  failureCode?: string,
) {
  await ensureCommandExecutionStore();
  const client = await getPostgresPool().connect();
  const scope = {
    tenantHashId: execution.tenantHashId,
    userHashId: execution.userHashId,
    workspaceId: execution.workspaceId,
  };
  try {
    await client.query("BEGIN");
    const update = await client.query(
      `
        UPDATE public.assistant_command_executions
        SET status = $3,
            backend = $4,
            result = $5::jsonb,
            output_truncated = $6,
            summary = $7,
            failure_code = $8,
            finished_at = NOW(),
            lease_expires_at = NULL,
            updated_at = NOW()
        WHERE execution_id = $1
          AND worker_id = $2
          AND status IN ('running', 'cancel_requested')
      `,
      [
        execution.executionId,
        execution.workerId,
        result.status,
        result.backend ?? null,
        JSON.stringify(result),
        result.outputTruncated,
        result.summary,
        failureCode ?? null,
      ],
    );
    if ((update.rowCount ?? 0) === 0) {
      const current = await selectExecution(client, scope, {
        executionId: execution.executionId,
        threadId: execution.threadId,
      });
      await client.query("COMMIT");
      return current;
    }
    let snapshot = (await selectExecution(client, scope, {
      executionId: execution.executionId,
      threadId: execution.threadId,
    }))!;
    const lastEventId = await appendEvent(client, execution.executionId, {
      execution: snapshot,
      result,
      type: "command_result",
    });
    snapshot = {
      ...snapshot,
      lastEventId,
    };
    const approvalResponse = createExecutionApprovalResponse(snapshot, result);
    await client.query(
      `
        UPDATE public.assistant_pending_actions
        SET status = $6,
            result = $7::jsonb,
            executed_at = NOW()
        WHERE tenant_hash_id = $1
          AND user_hash_id = $2
          AND workspace_id = $3
          AND thread_id = $4
          AND action_id = $5
      `,
      [
        execution.tenantHashId,
        execution.userHashId,
        execution.workspaceId,
        execution.threadId,
        execution.approvalId,
        result.status === "completed" ? "executed" : "failed",
        JSON.stringify(approvalResponse),
      ],
    );
    await client.query("COMMIT");
    return snapshot;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function failLostCommandExecutions() {
  await ensureCommandExecutionStore();
  const result = await getPostgresPool().query<{
    execution_id: string;
    tenant_hash_id: string;
    thread_id: string;
    user_hash_id: string;
    workspace_id: string;
  }>(
    `
      SELECT execution_id, tenant_hash_id, user_hash_id, workspace_id, thread_id
      FROM public.assistant_command_executions
      WHERE status IN ('running', 'cancel_requested')
        AND lease_expires_at <= NOW()
      FOR UPDATE SKIP LOCKED
    `,
  );
  for (const row of result.rows) {
    const scope = {
      tenantHashId: row.tenant_hash_id,
      userHashId: row.user_hash_id,
      workspaceId: row.workspace_id,
    };
    const snapshot = await selectExecution(getPostgresPool(), scope, {
      executionId: row.execution_id,
      threadId: row.thread_id,
    });
    if (!snapshot) {
      continue;
    }
    const failure = createFailureResult(
      snapshot,
      "Worker 租约失效，任务已标记失败且不会自动重试。",
    );
    await forceFinalizeLostExecution(scope, snapshot, failure);
  }
  return result.rows.length;
}

export async function expireQueuedCommandExecutions() {
  await ensureCommandExecutionStore();
  const result = await getPostgresPool().query<{
    execution_id: string;
    tenant_hash_id: string;
    thread_id: string;
    user_hash_id: string;
    workspace_id: string;
  }>(
    `
      SELECT execution_id, tenant_hash_id, user_hash_id, workspace_id, thread_id
      FROM public.assistant_command_executions
      WHERE status = 'queued'
        AND queue_expires_at <= NOW()
      FOR UPDATE SKIP LOCKED
    `,
  );
  for (const row of result.rows) {
    const scope = {
      tenantHashId: row.tenant_hash_id,
      userHashId: row.user_hash_id,
      workspaceId: row.workspace_id,
    };
    const snapshot = await selectExecution(getPostgresPool(), scope, {
      executionId: row.execution_id,
      threadId: row.thread_id,
    });
    if (!snapshot) {
      continue;
    }
    await forceExpireQueuedExecution(
      scope,
      snapshot,
      createTerminalResult(
        snapshot,
        "expired",
        "命令等待 Worker 超时，任务已过期。",
      ),
    );
  }
  return result.rows.length;
}

export async function cleanupCommandExecutionRetention() {
  await ensureCommandExecutionStore();
  await getPostgresPool().query(
    `
      DELETE FROM public.assistant_command_execution_events
      WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')
    `,
    [EVENT_RETENTION_DAYS],
  );
  await getPostgresPool().query(
    `
      DELETE FROM public.assistant_command_executions
      WHERE finished_at IS NOT NULL
        AND finished_at < NOW() - ($1::int * INTERVAL '1 day')
    `,
    [EXECUTION_RETENTION_DAYS],
  );
  await getPostgresPool().query(
    `
      DELETE FROM public.assistant_command_worker_heartbeats
      WHERE last_heartbeat_at < NOW() - INTERVAL '5 minutes'
    `,
  );
}

function executionSelectSql() {
  return `
    SELECT
      execution.agent_id,
      execution.approval_id,
      execution.args,
      execution.attempt,
      execution.backend,
      execution.cancel_requested_at,
      execution.command,
      execution.created_at,
      execution.cwd,
      execution.execution_id,
      execution.failure_code,
      execution.finished_at,
      events.last_event_id,
      execution.lease_expires_at,
      execution.max_attempts,
      execution.output_truncated,
      execution.parent_execution_id,
      execution.result,
      execution.root_execution_id,
      execution.started_at,
      execution.status,
      COALESCE(events.stderr, '') AS stderr,
      COALESCE(events.stdout, '') AS stdout,
      execution.summary,
      execution.thread_id,
      execution.timeout_ms,
      execution.tool_call_id,
      execution.updated_at,
      execution.workspace_id
    FROM public.assistant_command_executions AS execution
    LEFT JOIN LATERAL (
      SELECT
        MAX(event.id) AS last_event_id,
        STRING_AGG(event.payload->>'output', '' ORDER BY event.id)
          FILTER (WHERE event.event_type = 'command_output'
            AND event.payload->>'stream' = 'stdout') AS stdout,
        STRING_AGG(event.payload->>'output', '' ORDER BY event.id)
          FILTER (WHERE event.event_type = 'command_output'
            AND event.payload->>'stream' = 'stderr') AS stderr
      FROM public.assistant_command_execution_events AS event
      WHERE event.execution_id = execution.execution_id
    ) AS events ON TRUE
  `;
}

async function selectExecution(
  queryable: Pick<PoolClient, "query">,
  scope: PendingActionScope,
  {
    approvalId,
    executionId,
    forUpdate = false,
    threadId,
  }: {
    approvalId?: string;
    executionId?: string;
    forUpdate?: boolean;
    threadId: string;
  },
) {
  const field = executionId ? "execution.execution_id" : "execution.approval_id";
  const value = executionId ?? approvalId;
  const result = await queryable.query<ExecutionRow>(
    `${executionSelectSql()}
     WHERE execution.tenant_hash_id = $1
       AND execution.user_hash_id = $2
       AND execution.workspace_id = $3
       AND execution.thread_id = $4
       AND ${field} = $5
     ORDER BY execution.attempt DESC
     LIMIT 1
     ${forUpdate ? "FOR UPDATE OF execution" : ""}`,
    [
      scope.tenantHashId,
      scope.userHashId,
      scope.workspaceId,
      threadId,
      value,
    ],
  );
  return result.rows[0] ? rowToSnapshot(result.rows[0]) : null;
}

async function selectExecutionByRootAttempt(
  client: PoolClient,
  scope: PendingActionScope,
  threadId: string,
  rootExecutionId: string,
  attempt: number,
) {
  const result = await client.query<ExecutionRow>(
    `${executionSelectSql()}
     WHERE execution.tenant_hash_id = $1
       AND execution.user_hash_id = $2
       AND execution.workspace_id = $3
       AND execution.thread_id = $4
       AND execution.root_execution_id = $5
       AND execution.attempt = $6
     LIMIT 1`,
    [
      scope.tenantHashId,
      scope.userHashId,
      scope.workspaceId,
      threadId,
      rootExecutionId,
      attempt,
    ],
  );
  return result.rows[0] ? rowToSnapshot(result.rows[0]) : null;
}

async function appendEvent(
  client: Pick<PoolClient, "query">,
  executionId: string,
  event: CommandExecutionEvent,
) {
  const result = await client.query<Pick<EventRow, "id">>(
    `
      INSERT INTO public.assistant_command_execution_events (
        execution_id,
        event_type,
        payload
      )
      VALUES ($1, $2, $3::jsonb)
      RETURNING id
    `,
    [executionId, event.type, JSON.stringify(event)],
  );
  return String(result.rows[0]!.id);
}

async function assertHealthyWorker(client: PoolClient) {
  const result = await client.query<{ healthy: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM public.assistant_command_worker_heartbeats
        WHERE last_heartbeat_at > NOW() - ($1::int * INTERVAL '1 millisecond')
      ) AS healthy
    `,
    [WORKER_HEALTH_WINDOW_MS],
  );
  if (result.rows[0]?.healthy !== true) {
    throw new CommandExecutionStoreError(
      "execution_worker_unavailable",
      "当前没有健康的命令执行 Worker，审批未入队，可稍后重试。",
      503,
    );
  }
}

async function forceFinalizeLostExecution(
  scope: PendingActionScope,
  snapshot: CommandExecutionSnapshot,
  result: CommandExecutionResult,
) {
  const client = await getPostgresPool().connect();
  try {
    await client.query("BEGIN");
    const update = await client.query(
      `
        UPDATE public.assistant_command_executions
        SET status = 'failed',
            failure_code = 'worker_lost',
            result = $2::jsonb,
            summary = $3,
            finished_at = NOW(),
            lease_expires_at = NULL,
            updated_at = NOW()
        WHERE execution_id = $1
          AND status IN ('running', 'cancel_requested')
          AND lease_expires_at <= NOW()
      `,
      [snapshot.executionId, JSON.stringify(result), result.summary],
    );
    if ((update.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return;
    }
    const updated = (await selectExecution(client, scope, {
      executionId: snapshot.executionId,
      threadId: snapshot.threadId,
    }))!;
    await appendEvent(client, snapshot.executionId, {
      execution: updated,
      result,
      type: "command_result",
    });
    await updatePendingActionFromExecution(client, updated, result);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function forceExpireQueuedExecution(
  scope: PendingActionScope,
  snapshot: CommandExecutionSnapshot,
  result: CommandExecutionResult,
) {
  const client = await getPostgresPool().connect();
  try {
    await client.query("BEGIN");
    const update = await client.query(
      `
        UPDATE public.assistant_command_executions
        SET status = 'expired',
            failure_code = 'queue_expired',
            result = $2::jsonb,
            summary = $3,
            finished_at = NOW(),
            updated_at = NOW()
        WHERE execution_id = $1
          AND status = 'queued'
          AND queue_expires_at <= NOW()
      `,
      [snapshot.executionId, JSON.stringify(result), result.summary],
    );
    if ((update.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return;
    }
    const updated = (await selectExecution(client, scope, {
      executionId: snapshot.executionId,
      threadId: snapshot.threadId,
    }))!;
    await appendEvent(client, snapshot.executionId, {
      execution: updated,
      result,
      type: "command_result",
    });
    await updatePendingActionFromExecution(client, updated, result);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function updatePendingActionFromExecution(
  client: PoolClient,
  execution: CommandExecutionSnapshot,
  result: CommandExecutionResult,
) {
  const approvalResponse = createExecutionApprovalResponse(execution, result);
  await client.query(
    `
      UPDATE public.assistant_pending_actions AS pending
      SET status = $5,
          result = $6::jsonb,
          executed_at = NOW()
      FROM public.assistant_command_executions AS command_execution
      WHERE command_execution.execution_id = $1
        AND pending.tenant_hash_id = command_execution.tenant_hash_id
        AND pending.user_hash_id = command_execution.user_hash_id
        AND pending.workspace_id = $2
        AND pending.thread_id = $3
        AND pending.action_id = $4
    `,
    [
      execution.executionId,
      execution.workspaceId,
      execution.threadId,
      execution.approvalId,
      result.status === "completed" ? "executed" : "failed",
      JSON.stringify(approvalResponse),
    ],
  );
}

function rowToSnapshot(row: ExecutionRow): CommandExecutionSnapshot {
  const storedResult = toCommandExecutionResult(row.result);
  return {
    agentId: row.agent_id,
    approvalId: row.approval_id,
    args: toStringArray(row.args),
    attempt: row.attempt,
    ...(row.backend ? { backend: row.backend } : {}),
    cancelRequestedAt: row.cancel_requested_at
      ? toIsoString(row.cancel_requested_at)
      : null,
    command: row.command,
    createdAt: toIsoString(row.created_at),
    cwd: row.cwd,
    executionId: row.execution_id,
    ...(row.failure_code ? { failureCode: row.failure_code } : {}),
    finishedAt: row.finished_at ? toIsoString(row.finished_at) : null,
    lastEventId:
      row.last_event_id === null ? null : String(row.last_event_id),
    leaseExpiresAt: row.lease_expires_at
      ? toIsoString(row.lease_expires_at)
      : null,
    maxAttempts: row.max_attempts,
    outputTruncated:
      storedResult?.outputTruncated ?? row.output_truncated,
    parentExecutionId: row.parent_execution_id,
    ...(storedResult ? { result: storedResult } : {}),
    rootExecutionId: row.root_execution_id,
    startedAt: row.started_at ? toIsoString(row.started_at) : null,
    status: row.status,
    stderr: storedResult?.stderr ?? row.stderr ?? "",
    stdout: storedResult?.stdout ?? row.stdout ?? "",
    summary: storedResult?.summary ?? row.summary ?? statusSummary(row.status),
    threadId: row.thread_id,
    timeoutMs: row.timeout_ms,
    toolCallId: row.tool_call_id,
    updatedAt: toIsoString(row.updated_at),
    workspaceId: row.workspace_id,
  };
}

function createCancelledResult(
  snapshot: CommandExecutionSnapshot,
): CommandExecutionResult {
  return {
    args: snapshot.args,
    command: snapshot.command,
    cwd: snapshot.cwd,
    durationMs: snapshot.startedAt
      ? Math.max(0, Date.now() - new Date(snapshot.startedAt).getTime())
      : 0,
    executionId: snapshot.executionId,
    finishedAt: new Date().toISOString(),
    outputTruncated: snapshot.outputTruncated,
    status: "cancelled",
    stderr: snapshot.stderr,
    stdout: snapshot.stdout,
    summary: "命令执行已取消。",
  };
}

function createFailureResult(
  snapshot: CommandExecutionSnapshot,
  summary: string,
): CommandExecutionResult {
  return {
    args: snapshot.args,
    ...(snapshot.backend ? { backend: snapshot.backend } : {}),
    command: snapshot.command,
    cwd: snapshot.cwd,
    durationMs: snapshot.startedAt
      ? Math.max(0, Date.now() - new Date(snapshot.startedAt).getTime())
      : 0,
    executionId: snapshot.executionId,
    finishedAt: new Date().toISOString(),
    outputTruncated: snapshot.outputTruncated,
    status: "failed",
    stderr: snapshot.stderr,
    stdout: snapshot.stdout,
    summary,
  };
}

function createTerminalResult(
  snapshot: CommandExecutionSnapshot,
  status: Extract<CommandExecutionResult["status"], "expired">,
  summary: string,
): CommandExecutionResult {
  return {
    args: snapshot.args,
    command: snapshot.command,
    cwd: snapshot.cwd,
    durationMs: 0,
    executionId: snapshot.executionId,
    finishedAt: new Date().toISOString(),
    outputTruncated: snapshot.outputTruncated,
    status,
    stderr: snapshot.stderr,
    stdout: snapshot.stdout,
    summary,
  };
}

function createExecutionApprovalResponse(
  execution: CommandExecutionSnapshot,
  result: CommandExecutionResult,
): ApprovalExecutionResponse {
  const ok = result.status === "completed";
  return {
    approvalId: execution.approvalId,
    approved: true,
    commandExecution: execution,
    commandResult: result,
    decision: "approve",
    finalText: result.summary,
    isError: !ok,
    ok,
    status: ok ? "executed" : "failed",
    structuredResponse: {
      answer: result.summary,
      confidence: 1,
      keyFacts: [result.summary],
      toolResults: [
        {
          summary: result.summary,
          toolName: "execute_command",
        },
      ],
    },
    toolCallId: execution.toolCallId,
    toolName: "execute_command",
    toolResult: {
      content: JSON.stringify({
        commandResult: result,
        ok,
        summary: result.summary,
      }),
      status: ok ? "success" : "error",
    },
  };
}

function toCommandArgs(value: unknown) {
  if (!isRecord(value)) {
    throw new CommandExecutionStoreError(
      "invalid_tool_args",
      "命令参数不是对象。",
      400,
    );
  }
  if (
    typeof value.command !== "string" ||
    !Array.isArray(value.args) ||
    !value.args.every((arg) => typeof arg === "string") ||
    typeof value.cwd !== "string" ||
    typeof value.timeoutMs !== "number"
  ) {
    throw new CommandExecutionStoreError(
      "invalid_tool_args",
      "命令参数不完整。",
      400,
    );
  }
  return {
    args: value.args,
    command: value.command,
    cwd: value.cwd,
    timeoutMs: value.timeoutMs,
  };
}

function toExecutionEvent(value: unknown): CommandExecutionEvent | null {
  if (!isRecord(value) || typeof value.type !== "string") {
    return null;
  }
  if (
    value.type === "command_output" ||
    value.type === "command_state" ||
    value.type === "command_result"
  ) {
    return value as CommandExecutionEvent;
  }
  return null;
}

function toCommandExecutionResult(
  value: unknown,
): CommandExecutionResult | undefined {
  if (
    !isRecord(value) ||
    typeof value.executionId !== "string" ||
    typeof value.status !== "string"
  ) {
    return undefined;
  }
  return value as CommandExecutionResult;
}

function toStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function statusSummary(status: CommandExecutionTaskStatus) {
  if (status === "queued") {
    return "命令已进入持久执行队列。";
  }
  if (status === "running") {
    return "命令正在安全 Sandbox 中执行。";
  }
  if (status === "cancel_requested") {
    return "正在终止命令进程。";
  }
  return "命令执行已结束。";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toIsoString(value: Date | string) {
  return typeof value === "string" ? value : value.toISOString();
}

async function setupCommandExecutionTables() {
  const pool = getPostgresPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.assistant_command_executions (
      id BIGSERIAL PRIMARY KEY,
      tenant_hash_id TEXT NOT NULL,
      user_hash_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      execution_id TEXT NOT NULL UNIQUE,
      approval_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      command TEXT NOT NULL,
      args JSONB NOT NULL DEFAULT '[]'::jsonb,
      cwd TEXT NOT NULL,
      timeout_ms INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      attempt INTEGER NOT NULL DEFAULT 1,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      root_execution_id TEXT NOT NULL,
      parent_execution_id TEXT,
      worker_id TEXT,
      lease_expires_at TIMESTAMPTZ,
      queue_expires_at TIMESTAMPTZ NOT NULL,
      cancel_requested_at TIMESTAMPTZ,
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      backend TEXT,
      result JSONB,
      output_truncated BOOLEAN NOT NULL DEFAULT FALSE,
      failure_code TEXT,
      summary TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS assistant_command_executions_scope_execution_idx
    ON public.assistant_command_executions (
      tenant_hash_id,
      user_hash_id,
      workspace_id,
      thread_id,
      execution_id
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS assistant_command_executions_root_attempt_idx
    ON public.assistant_command_executions (root_execution_id, attempt)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS assistant_command_executions_claim_idx
    ON public.assistant_command_executions (status, created_at)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS assistant_command_executions_lease_idx
    ON public.assistant_command_executions (status, lease_expires_at)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS assistant_command_executions_thread_idx
    ON public.assistant_command_executions (
      tenant_hash_id,
      user_hash_id,
      workspace_id,
      thread_id,
      created_at DESC
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.assistant_command_execution_events (
      id BIGSERIAL PRIMARY KEY,
      execution_id TEXT NOT NULL
        REFERENCES public.assistant_command_executions(execution_id)
        ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS assistant_command_execution_events_execution_idx
    ON public.assistant_command_execution_events (execution_id, id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS assistant_command_execution_events_retention_idx
    ON public.assistant_command_execution_events (created_at)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.assistant_command_worker_heartbeats (
      worker_id TEXT PRIMARY KEY,
      concurrency INTEGER NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}
