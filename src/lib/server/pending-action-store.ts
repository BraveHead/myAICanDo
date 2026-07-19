import type {
  ApprovalActionStatus,
  ApprovalExecutionResponse,
  ApprovalGatedToolName,
} from "@/lib/approval-actions";
import type { SupportedAgent } from "@/lib/agent/shared/agent-ids";
import { getPostgresPool, hasDatabaseUrl } from "./postgres";

export type PendingActionScope = {
  tenantHashId: string;
  userHashId: string;
  workspaceId: string;
};

export type StoredPendingAction = {
  actionId: string;
  agentId: SupportedAgent;
  args: Record<string, unknown>;
  createdAt: string;
  decidedAt: string | null;
  executedAt: string | null;
  executionStartedAt: string | null;
  expiresAt: string;
  reason: string | null;
  result: ApprovalExecutionResponse | null;
  status: ApprovalActionStatus;
  threadId: string;
  toolCallId: string;
  toolName: ApprovalGatedToolName;
  workspaceId: string | null;
};

type PendingActionRow = {
  action_id: string;
  agent_id: SupportedAgent;
  args: unknown;
  created_at: Date | string;
  decided_at: Date | string | null;
  executed_at: Date | string | null;
  execution_started_at: Date | string | null;
  expires_at: Date | string;
  reason: string | null;
  result: unknown;
  status: ApprovalActionStatus;
  thread_id: string;
  tool_call_id: string;
  tool_name: ApprovalGatedToolName;
  workspace_id: string | null;
};

let setupPromise: Promise<void> | null = null;

const DEFAULT_PENDING_ACTION_TTL_MS = 30 * 60 * 1000;

export function hasPendingActionStore() {
  return hasDatabaseUrl();
}

async function ensurePendingActionStore() {
  if (!hasDatabaseUrl()) {
    return;
  }

  setupPromise ??= setupAssistantPendingActionsTable();
  await setupPromise;
}

export async function createPendingAction(
  scope: PendingActionScope,
  {
    agentId,
    args,
    threadId,
    toolCallId,
    toolName,
    ttlMs = DEFAULT_PENDING_ACTION_TTL_MS,
  }: {
    agentId: SupportedAgent;
    args: unknown;
    threadId: string;
    toolCallId: string;
    toolName: ApprovalGatedToolName;
    ttlMs?: number;
  },
) {
  if (!hasDatabaseUrl()) {
    return null;
  }

  await ensurePendingActionStore();

  const actionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + ttlMs);
  const result = await getPostgresPool().query<PendingActionRow>(
    `
      INSERT INTO public.assistant_pending_actions (
        tenant_hash_id,
        user_hash_id,
        workspace_id,
        thread_id,
        action_id,
        agent_id,
        tool_name,
        tool_call_id,
        args,
        expires_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
      RETURNING
        workspace_id,
        thread_id,
        action_id,
        agent_id,
        tool_name,
        tool_call_id,
        args,
        status,
        result,
        reason,
        created_at,
        decided_at,
        executed_at,
        execution_started_at,
        expires_at
    `,
    [
      scope.tenantHashId,
      scope.userHashId,
      scope.workspaceId,
      threadId,
      actionId,
      agentId,
      toolName,
      toolCallId,
      JSON.stringify(toJsonRecord(args)),
      expiresAt,
    ],
  );

  return result.rows[0] ? rowToStoredPendingAction(result.rows[0]) : null;
}

export async function decidePendingAction(
  scope: PendingActionScope,
  {
    actionId,
    approved,
    reason,
    threadId,
  }: {
    actionId: string;
    approved: boolean;
    reason?: string;
    threadId: string;
  },
) {
  if (!hasDatabaseUrl()) {
    return null;
  }

  await ensurePendingActionStore();

  const result = await getPostgresPool().query<PendingActionRow>(
    `
      UPDATE public.assistant_pending_actions
      SET
        workspace_id = $3,
        status = CASE
          WHEN expires_at <= NOW() THEN 'expired'
          WHEN $6::boolean THEN 'approved'
          ELSE 'rejected'
        END,
        decided_at = CASE
          WHEN decided_at IS NULL THEN NOW()
          ELSE decided_at
        END,
        reason = $7,
        result = result
      WHERE
        tenant_hash_id = $1
        AND user_hash_id = $2
        AND workspace_id = $3
        AND thread_id = $4
        AND action_id = $5
        AND status = 'pending'
      RETURNING
        workspace_id,
        thread_id,
        action_id,
        agent_id,
        tool_name,
        tool_call_id,
        args,
        status,
        result,
        reason,
        created_at,
        decided_at,
        executed_at,
        execution_started_at,
        expires_at
    `,
    [
      scope.tenantHashId,
      scope.userHashId,
      scope.workspaceId,
      threadId,
      actionId,
      approved,
      reason ?? null,
    ],
  );

  if (result.rows[0]) {
    return rowToStoredPendingAction(result.rows[0]);
  }

  return getPendingAction(scope, {
    actionId,
    threadId,
  });
}

export async function updatePendingActionArgs(
  scope: PendingActionScope,
  {
    actionId,
    args,
    threadId,
  }: {
    actionId: string;
    args: unknown;
    threadId: string;
  },
) {
  if (!hasDatabaseUrl()) {
    return null;
  }

  await ensurePendingActionStore();

  const result = await getPostgresPool().query<PendingActionRow>(
    `
      UPDATE public.assistant_pending_actions
      SET
        workspace_id = $3,
        args = $6::jsonb
      WHERE
        tenant_hash_id = $1
        AND user_hash_id = $2
        AND workspace_id = $3
        AND thread_id = $4
        AND action_id = $5
        AND status = 'pending'
      RETURNING
        workspace_id,
        thread_id,
        action_id,
        agent_id,
        tool_name,
        tool_call_id,
        args,
        status,
        result,
        reason,
        created_at,
        decided_at,
        executed_at,
        execution_started_at,
        expires_at
    `,
    [
      scope.tenantHashId,
      scope.userHashId,
      scope.workspaceId,
      threadId,
      actionId,
      JSON.stringify(toJsonRecord(args)),
    ],
  );

  return result.rows[0] ? rowToStoredPendingAction(result.rows[0]) : null;
}

export async function claimPendingActionExecution(
  scope: PendingActionScope,
  {
    actionId,
    threadId,
  }: {
    actionId: string;
    threadId: string;
  },
) {
  if (!hasDatabaseUrl()) {
    return null;
  }

  await ensurePendingActionStore();

  const result = await getPostgresPool().query<PendingActionRow>(
    `
      UPDATE public.assistant_pending_actions
      SET
        workspace_id = $3,
        status = 'executing',
        execution_started_at = NOW()
      WHERE
        tenant_hash_id = $1
        AND user_hash_id = $2
        AND workspace_id = $3
        AND thread_id = $4
        AND action_id = $5
        AND status = 'approved'
        AND expires_at > NOW()
      RETURNING
        workspace_id,
        thread_id,
        action_id,
        agent_id,
        tool_name,
        tool_call_id,
        args,
        status,
        result,
        reason,
        created_at,
        decided_at,
        executed_at,
        execution_started_at,
        expires_at
    `,
    [
      scope.tenantHashId,
      scope.userHashId,
      scope.workspaceId,
      threadId,
      actionId,
    ],
  );

  return result.rows[0] ? rowToStoredPendingAction(result.rows[0]) : null;
}

export async function markPendingActionExecuted(
  scope: PendingActionScope,
  {
    actionId,
    result,
    threadId,
  }: {
    actionId: string;
    result: ApprovalExecutionResponse;
    threadId: string;
  },
) {
  return updatePendingActionResult(scope, {
    actionId,
    result,
    status: "executed",
    threadId,
  });
}

export async function markPendingActionFailed(
  scope: PendingActionScope,
  {
    actionId,
    result,
    threadId,
  }: {
    actionId: string;
    result: ApprovalExecutionResponse;
    threadId: string;
  },
) {
  return updatePendingActionResult(scope, {
    actionId,
    result,
    status: "failed",
    threadId,
  });
}

export async function markPendingActionRejected(
  scope: PendingActionScope,
  {
    actionId,
    result,
    threadId,
  }: {
    actionId: string;
    result: ApprovalExecutionResponse;
    threadId: string;
  },
) {
  return updatePendingActionResult(scope, {
    actionId,
    result,
    status: "rejected",
    threadId,
  });
}

export async function markPendingActionExpired(
  scope: PendingActionScope,
  {
    actionId,
    result,
    threadId,
  }: {
    actionId: string;
    result: ApprovalExecutionResponse;
    threadId: string;
  },
) {
  return updatePendingActionResult(scope, {
    actionId,
    result,
    status: "expired",
    threadId,
  });
}

export async function getPendingActionForScope(
  scope: PendingActionScope,
  args: { actionId: string; threadId: string },
) {
  return getPendingAction(scope, args);
}

async function getPendingAction(
  scope: PendingActionScope,
  {
    actionId,
    threadId,
  }: {
    actionId: string;
    threadId: string;
  },
) {
  if (!hasDatabaseUrl()) {
    return null;
  }

  await ensurePendingActionStore();

  const result = await getPostgresPool().query<PendingActionRow>(
    `
      SELECT
        workspace_id,
        thread_id,
        action_id,
        agent_id,
        tool_name,
        tool_call_id,
        args,
        status,
        result,
        reason,
        created_at,
        decided_at,
        executed_at,
        execution_started_at,
        expires_at
      FROM public.assistant_pending_actions
      WHERE
        tenant_hash_id = $1
        AND user_hash_id = $2
        AND workspace_id = $3
        AND thread_id = $4
        AND action_id = $5
      LIMIT 1
    `,
    [scope.tenantHashId, scope.userHashId, scope.workspaceId, threadId, actionId],
  );

  return result.rows[0] ? rowToStoredPendingAction(result.rows[0]) : null;
}

async function updatePendingActionResult(
  scope: PendingActionScope,
  {
    actionId,
    result,
    status,
    threadId,
  }: {
    actionId: string;
    result: ApprovalExecutionResponse;
    status: Extract<
      ApprovalActionStatus,
      "executed" | "failed" | "rejected" | "expired"
    >;
    threadId: string;
  },
) {
  if (!hasDatabaseUrl()) {
    return null;
  }

  await ensurePendingActionStore();

  const updateResult = await getPostgresPool().query<PendingActionRow>(
    `
      UPDATE public.assistant_pending_actions
      SET
        workspace_id = $3,
        status = $6,
        result = $7::jsonb,
        executed_at = CASE
          WHEN $6 IN ('executed', 'failed') THEN NOW()
          ELSE executed_at
        END
      WHERE
        tenant_hash_id = $1
        AND user_hash_id = $2
        AND workspace_id = $3
        AND thread_id = $4
        AND action_id = $5
        AND result IS NULL
        AND status = CASE
          WHEN $6 IN ('executed', 'failed') THEN 'executing'
          ELSE $6
        END
      RETURNING
        workspace_id,
        thread_id,
        action_id,
        agent_id,
        tool_name,
        tool_call_id,
        args,
        status,
        result,
        reason,
        created_at,
        decided_at,
        executed_at,
        execution_started_at,
        expires_at
    `,
    [
      scope.tenantHashId,
      scope.userHashId,
      scope.workspaceId,
      threadId,
      actionId,
      status,
      JSON.stringify(result),
    ],
  );

  return updateResult.rows[0]
    ? rowToStoredPendingAction(updateResult.rows[0])
    : null;
}

async function setupAssistantPendingActionsTable() {
  const pool = getPostgresPool();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.assistant_pending_actions (
      id BIGSERIAL PRIMARY KEY,
      tenant_hash_id TEXT NOT NULL,
      user_hash_id TEXT NOT NULL,
      workspace_id TEXT,
      thread_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      args JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'pending',
      result JSONB,
      reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      decided_at TIMESTAMPTZ,
      executed_at TIMESTAMPTZ,
      execution_started_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ NOT NULL
    )
  `);

  await pool.query(`
    ALTER TABLE public.assistant_pending_actions
    ADD COLUMN IF NOT EXISTS workspace_id TEXT
  `);
  await pool.query(`
    ALTER TABLE public.assistant_pending_actions
    ADD COLUMN IF NOT EXISTS execution_started_at TIMESTAMPTZ
  `);

  try {
    await pool.query(`
      UPDATE public.assistant_pending_actions AS pending
      SET workspace_id = threads.workspace_id
      FROM public.assistant_threads AS threads
      WHERE pending.workspace_id IS NULL
        AND pending.tenant_hash_id = threads.tenant_hash_id
        AND pending.user_hash_id = threads.user_hash_id
        AND pending.thread_id = threads.thread_id
        AND threads.workspace_id IS NOT NULL
    `);
  } catch (error) {
    if (!isMissingTableError(error)) {
      throw error;
    }
  }

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS assistant_pending_actions_workspace_scope_action_idx
    ON public.assistant_pending_actions (
      tenant_hash_id,
      user_hash_id,
      workspace_id,
      thread_id,
      action_id
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS assistant_pending_actions_status_expires_idx
    ON public.assistant_pending_actions (status, expires_at)
  `);
}

function rowToStoredPendingAction(row: PendingActionRow): StoredPendingAction {
  return {
    actionId: row.action_id,
    agentId: row.agent_id,
    args: toJsonRecord(row.args),
    createdAt: toIsoString(row.created_at),
    decidedAt: row.decided_at ? toIsoString(row.decided_at) : null,
    executedAt: row.executed_at ? toIsoString(row.executed_at) : null,
    executionStartedAt: row.execution_started_at
      ? toIsoString(row.execution_started_at)
      : null,
    expiresAt: toIsoString(row.expires_at),
    reason: row.reason,
    result: isApprovalExecutionResponse(row.result) ? row.result : null,
    status: row.status,
    threadId: row.thread_id,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    workspaceId: row.workspace_id,
  };
}

function toJsonRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function isApprovalExecutionResponse(
  value: unknown,
): value is ApprovalExecutionResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Partial<ApprovalExecutionResponse>;
  return (
    typeof candidate.approvalId === "string" &&
    typeof candidate.finalText === "string" &&
    typeof candidate.toolCallId === "string" &&
    typeof candidate.toolName === "string" &&
    typeof candidate.toolResult === "object"
  );
}

function toIsoString(value: Date | string) {
  return typeof value === "string" ? value : value.toISOString();
}

function isMissingTableError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "42P01"
  );
}
