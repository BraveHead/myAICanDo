import type {
  ApprovalActionStatus,
  ApprovalExecutionResponse,
  ApprovalGatedToolName,
  ApprovalToolResult,
} from "@/lib/approval-actions";
import {
  deleteUserMemory,
  saveUserMemory,
  type DeleteUserMemoryResult,
  type SaveUserMemoryResult,
} from "@/lib/agent/services/memory-service";
import { isSupportedAgent } from "@/lib/agent/shared/agent-ids";
import { authErrorResponse, requireTenantAccess } from "@/lib/server/saas";
import {
  decidePendingAction,
  hasPendingActionStore,
  markPendingActionExecuted,
  markPendingActionFailed,
  markPendingActionRejected,
  type StoredPendingAction,
} from "@/lib/server/pending-action-store";
import { createRequestLogger, toLogError } from "@/lib/server/logger";
import { appendThreadMessages } from "@/lib/server/thread-store";

type ApprovalRequestBody = {
  approvalId?: string;
  approved?: boolean;
  reason?: string;
  threadId?: string;
};

type ApprovalRouteContext = {
  params: Promise<{
    tenantId: string;
  }>;
};

type MemoryMutationResult = SaveUserMemoryResult | DeleteUserMemoryResult;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const APPROVAL_ROUTE = "/api/tenants/[tenantId]/chat/approvals";

export async function POST(request: Request, context: ApprovalRouteContext) {
  const requestStartedAt = Date.now();
  const requestId = crypto.randomUUID();
  const { tenantId } = await context.params;
  const routeLogger = createRequestLogger({
    requestId,
    route: APPROVAL_ROUTE,
    tenantId,
  });
  let access;

  try {
    access = await requireTenantAccess(tenantId);
  } catch (error) {
    routeLogger.warn({ err: toLogError(error) }, "approval auth failed");
    return authErrorResponse(error);
  }

  let body: ApprovalRequestBody;
  try {
    body = (await request.json()) as ApprovalRequestBody;
  } catch (error) {
    routeLogger.warn(
      { err: toLogError(error) },
      "approval request body is invalid",
    );
    return Response.json(
      {
        error: {
          code: "invalid_json",
          message: "请求体必须是合法 JSON。",
        },
      },
      { status: 400 },
    );
  }

  const approvalId = normalizeNonEmptyString(body.approvalId);
  const threadId = normalizeNonEmptyString(body.threadId);
  if (!approvalId || !threadId || typeof body.approved !== "boolean") {
    return Response.json(
      {
        error: {
          code: "invalid_approval_request",
          message: "缺少 threadId、approvalId 或 approved。",
        },
      },
      { status: 400 },
    );
  }

  if (!hasPendingActionStore()) {
    return Response.json(
      {
        error: {
          code: "pending_action_store_unavailable",
          message: "未配置 DATABASE_URL，无法执行人工确认。",
        },
      },
      { status: 500 },
    );
  }

  const scope = {
    tenantHashId: access.tenantHashId,
    userHashId: access.userHashId,
  };
  const requestLogger = createRequestLogger({
    approvalId,
    requestId,
    route: APPROVAL_ROUTE,
    tenantHashId: access.tenantHashId,
    threadId,
    userHashId: access.userHashId,
  });

  const action = await decidePendingAction(scope, {
    actionId: approvalId,
    approved: body.approved,
    reason: body.reason,
    threadId,
  });

  if (!action) {
    requestLogger.warn("approval action not found");
    return Response.json(
      {
        error: {
          code: "approval_not_found",
          message: "确认请求不存在或不属于当前租户/用户/thread。",
        },
      },
      { status: 404 },
    );
  }

  if (action.status === "expired") {
    const expiredResponse = createTerminalApprovalResponse({
      action,
      finalText: "这次确认已过期，请重新发起记忆操作。",
      isError: true,
      ok: false,
      status: "expired",
      toolResult: createToolErrorResult({
        code: "approval_expired",
        message: "The approval action has expired.",
        summary: "这次确认已过期，请重新发起记忆操作。",
      }),
    });
    await persistApprovalText({
      action,
      response: expiredResponse,
      scope,
      threadId,
    });
    requestLogger.warn("approval action expired");
    return Response.json(expiredResponse, { status: 409 });
  }

  if (action.result && isTerminalStatus(action.status)) {
    requestLogger.info(
      {
        durationMs: Date.now() - requestStartedAt,
        status: action.status,
      },
      "approval action returned cached result",
    );
    return Response.json(action.result);
  }

  if (action.status === "rejected") {
    const response = createRejectedApprovalResponse({
      action,
      approvalId,
      reason: body.reason,
    });
    await markPendingActionRejected(scope, {
      actionId: approvalId,
      result: response,
      threadId,
    });
    await persistApprovalText({
      action,
      response,
      scope,
      threadId,
    });
    requestLogger.info(
      {
        durationMs: Date.now() - requestStartedAt,
      },
      "approval action rejected",
    );
    return Response.json(response);
  }

  if (action.status !== "approved") {
    return Response.json(
      {
        error: {
          code: "approval_not_pending",
          message: `确认请求当前状态为 ${action.status}，不能执行。`,
        },
      },
      { status: 409 },
    );
  }

  const response = await executeApprovedAction(action, {
    tenantHashId: access.tenantHashId,
    userHashId: access.userHashId,
  });
  if (response.ok) {
    await markPendingActionExecuted(scope, {
      actionId: approvalId,
      result: response,
      threadId,
    });
  } else {
    await markPendingActionFailed(scope, {
      actionId: approvalId,
      result: response,
      threadId,
    });
  }
  await persistApprovalText({
    action,
    response,
    scope,
    threadId,
  });

  requestLogger.info(
    {
      durationMs: Date.now() - requestStartedAt,
      ok: response.ok,
      toolName: action.toolName,
    },
    "approval action executed",
  );

  return Response.json(response);
}

async function executeApprovedAction(
  action: StoredPendingAction,
  threadScope: { tenantHashId: string; userHashId: string },
): Promise<ApprovalExecutionResponse> {
  if (action.toolName === "save_memory") {
    const input = getSaveMemoryInput(action.args);
    if (!input.ok) {
      return createInvalidArgsResponse(action, input.message);
    }

    return createMemoryMutationResponse({
      action,
      result: await saveUserMemory(
        {
          threadId: action.threadId,
          threadScope,
        },
        input.value,
      ),
    });
  }

  if (action.toolName === "delete_memory") {
    const input = getDeleteMemoryInput(action.args);
    if (!input.ok) {
      return createInvalidArgsResponse(action, input.message);
    }

    return createMemoryMutationResponse({
      action,
      result: await deleteUserMemory(
        {
          threadId: action.threadId,
          threadScope,
        },
        input.value.memoryId,
      ),
    });
  }

  return createInvalidArgsResponse(action, "Unsupported approval-gated tool.");
}

function createMemoryMutationResponse({
  action,
  result,
}: {
  action: StoredPendingAction;
  result: MemoryMutationResult;
}): ApprovalExecutionResponse {
  const toolResult = {
    content: JSON.stringify(result),
    status: result.ok ? "success" : "error",
  } satisfies ApprovalToolResult;

  return createTerminalApprovalResponse({
    action,
    finalText: result.summary,
    isError: !result.ok,
    ok: result.ok,
    status: result.ok ? "executed" : "failed",
    toolResult,
  });
}

function createInvalidArgsResponse(
  action: StoredPendingAction,
  message: string,
): ApprovalExecutionResponse {
  const finalText = `确认请求参数无效：${message}`;
  return createTerminalApprovalResponse({
    action,
    finalText,
    isError: true,
    ok: false,
    status: "failed",
    toolResult: createToolErrorResult({
      code: "invalid_tool_args",
      message,
      summary: finalText,
    }),
  });
}

function createRejectedApprovalResponse({
  action,
  approvalId,
  reason,
}: {
  action?: StoredPendingAction;
  approvalId: string;
  reason?: string;
}): ApprovalExecutionResponse {
  const finalText = reason?.trim()
    ? `已取消这次记忆操作：${reason.trim()}`
    : "已取消这次记忆操作。";
  const toolName = action?.toolName ?? "save_memory";
  const toolCallId = action?.toolCallId ?? approvalId;
  const toolResult = createToolErrorResult({
    code: "approval_rejected",
    message: reason?.trim() || "The user rejected this approval request.",
    summary: finalText,
  });

  return {
    approvalId,
    approved: false,
    finalText,
    isError: false,
    ok: true,
    status: "rejected",
    structuredResponse: createStructuredResponse({
      finalText,
      toolName,
    }),
    toolCallId,
    toolName,
    toolResult,
  };
}

function createTerminalApprovalResponse({
  action,
  finalText,
  isError,
  ok,
  status,
  toolResult,
}: {
  action: StoredPendingAction;
  finalText: string;
  isError: boolean;
  ok: boolean;
  status: ApprovalActionStatus;
  toolResult: ApprovalToolResult;
}): ApprovalExecutionResponse {
  return {
    approvalId: action.actionId,
    approved: status === "executed" || status === "failed",
    finalText,
    isError,
    ok,
    status,
    structuredResponse: createStructuredResponse({
      finalText,
      toolName: action.toolName,
    }),
    toolCallId: action.toolCallId,
    toolName: action.toolName,
    toolResult,
  };
}

function createStructuredResponse({
  finalText,
  toolName,
}: {
  finalText: string;
  toolName: ApprovalGatedToolName;
}) {
  return {
    answer: finalText,
    confidence: 1,
    keyFacts: [finalText],
    toolResults: [
      {
        summary: finalText,
        toolName,
      },
    ],
  };
}

function createToolErrorResult({
  code,
  message,
  summary,
}: {
  code: string;
  message: string;
  summary: string;
}): ApprovalToolResult {
  return {
    content: JSON.stringify({
      ok: false,
      summary,
      error: {
        code,
        message,
      },
    }),
    status: "error",
  };
}

async function persistApprovalText({
  action,
  response,
  scope,
  threadId,
}: {
  action: StoredPendingAction;
  response: ApprovalExecutionResponse;
  scope: { tenantHashId: string; userHashId: string };
  threadId: string;
}) {
  await appendThreadMessages({
    agent: isSupportedAgent(action.agentId) ? action.agentId : undefined,
    messages: [
      {
        role: "assistant",
        content: response.finalText,
      },
    ],
    scope,
    threadId,
  });
}

function getSaveMemoryInput(args: Record<string, unknown>):
  | {
      ok: true;
      value: {
        category?: string;
        content: string;
        metadata?: Record<string, unknown>;
      };
    }
  | { ok: false; message: string } {
  const content = typeof args.content === "string" ? args.content.trim() : "";
  if (!content) {
    return {
      ok: false,
      message: "save_memory.content must be a non-empty string.",
    };
  }

  return {
    ok: true,
    value: {
      content,
      ...(typeof args.category === "string"
        ? { category: args.category }
        : {}),
      ...(isRecord(args.metadata)
        ? { metadata: args.metadata }
        : {}),
    },
  };
}

function getDeleteMemoryInput(args: Record<string, unknown>):
  | {
      ok: true;
      value: {
        memoryId: string;
      };
    }
  | { ok: false; message: string } {
  const memoryId =
    typeof args.memoryId === "string" ? args.memoryId.trim() : "";
  if (!memoryId) {
    return {
      ok: false,
      message: "delete_memory.memoryId must be a non-empty string.",
    };
  }

  return {
    ok: true,
    value: {
      memoryId,
    },
  };
}

function isTerminalStatus(status: ApprovalActionStatus) {
  return status === "executed" || status === "rejected" || status === "failed";
}

function normalizeNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
