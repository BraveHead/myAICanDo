import type {
  ApprovalActionStatus,
  ApprovalDecision,
  ApprovalExecutionResponse,
  ApprovalGatedToolName,
  ApprovalToolResult,
} from "@/lib/approval-actions";
import {
  executeApprovalTool,
  getApprovalPolicy,
  getApprovalSubject,
} from "@/lib/approval-policy";
import { isSupportedAgent } from "@/lib/agent/shared/agent-ids";
import { authErrorResponse, requireTenantAccess } from "@/lib/server/saas";
import { requireWorkspaceAccess } from "@/lib/server/workspace-context";
import { getStoredThreadWorkspaceId } from "@/lib/server/thread-store/persistence";
import {
  appendThreadMessages,
} from "@/lib/server/thread-store";
import type { ThreadScope } from "@/lib/server/thread-store/persistence";
import {
  claimPendingActionExecution,
  decidePendingAction,
  getPendingActionForScope,
  hasPendingActionStore,
  markPendingActionExpired,
  markPendingActionExecuted,
  markPendingActionFailed,
  markPendingActionRejected,
  updatePendingActionArgs,
  type PendingActionScope,
  type StoredPendingAction,
} from "@/lib/server/pending-action-store";
import { createRequestLogger, toLogError } from "@/lib/server/logger";

type ApprovalRequestBody = {
  approvalId?: unknown;
  approved?: unknown;
  args?: unknown;
  decision?: unknown;
  guidance?: unknown;
  reason?: unknown;
  threadId?: unknown;
  workspaceId?: unknown;
};

type ApprovalRouteContext = {
  params: Promise<{
    tenantId: string;
  }>;
};

type NormalizedApprovalRequest = {
  approvalId: string;
  args?: unknown;
  decision: ApprovalDecision;
  guidance?: string;
  reason?: string;
  threadId: string;
  workspaceId?: string;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const APPROVAL_ROUTE = "/api/tenants/[tenantId]/chat/approvals";
const MAX_GUIDANCE_LENGTH = 2_000;
const MAX_REASON_LENGTH = 2_000;

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
    return errorResponse("invalid_json", "请求体必须是合法 JSON。", 400);
  }

  const normalized = normalizeApprovalRequest(body);
  if (!normalized.ok) {
    return errorResponse(
      normalized.code,
      normalized.message,
      normalized.status,
    );
  }

  if (!hasPendingActionStore()) {
    return errorResponse(
      "pending_action_store_unavailable",
      "未配置 DATABASE_URL，无法执行人工确认。",
      500,
    );
  }

  const storedWorkspaceId = await getStoredThreadWorkspaceId(
    access,
    normalized.value.threadId,
  );
  if (!storedWorkspaceId) {
    return errorResponse(
      "thread_not_found",
      "线程不存在或未绑定工作区。",
      404,
    );
  }

  if (
    normalized.value.workspaceId &&
    normalized.value.workspaceId !== storedWorkspaceId
  ) {
    return errorResponse(
      "thread_workspace_mismatch",
      "确认请求不能跨工作区执行。",
      403,
    );
  }

  let workspaceAccess;
  try {
    workspaceAccess = await requireWorkspaceAccess(tenantId, storedWorkspaceId);
  } catch (error) {
    return authErrorResponse(error);
  }

  const scope: PendingActionScope = {
    tenantHashId: access.tenantHashId,
    userHashId: access.userHashId,
    workspaceId: workspaceAccess.workspace.workspaceId,
  };
  const threadScope: ThreadScope = scope;
  const requestLogger = createRequestLogger({
    approvalId: normalized.value.approvalId,
    requestId,
    route: APPROVAL_ROUTE,
    tenantHashId: access.tenantHashId,
    threadId: normalized.value.threadId,
    userHashId: access.userHashId,
    workspaceId: scope.workspaceId,
  });

  let action = await getPendingActionForScope(scope, {
    actionId: normalized.value.approvalId,
    threadId: normalized.value.threadId,
  });
  if (!action) {
    requestLogger.warn("approval action not found");
    return errorResponse(
      "approval_not_found",
      "确认请求不存在或不属于当前租户/用户/workspace/thread。",
      404,
    );
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

  if (action.status === "executing") {
    return errorResponse(
      "approval_execution_in_progress",
      "该确认请求正在执行，请勿重复提交。",
      409,
    );
  }

  if (action.status === "expired" || isExpired(action.expiresAt)) {
    const response = createExpiredApprovalResponse(action);
    const expiredAction = await markPendingActionExpired(scope, {
      actionId: action.actionId,
      result: response,
      threadId: action.threadId,
    });
    if (expiredAction) {
      await persistApprovalText({ action, response, scope });
    } else {
      const latestAction = await getPendingActionForScope(scope, {
        actionId: action.actionId,
        threadId: action.threadId,
      });
      if (latestAction?.result) {
        return Response.json(latestAction.result, { status: 409 });
      }
    }
    return Response.json(response, { status: 409 });
  }

  if (normalized.value.decision === "edit_args") {
    const policy = getApprovalPolicy(action.toolName);
    const validation = policy?.validateArgs(normalized.value.args);
    if (!policy || !policy.supportsEditArgs || !validation?.ok) {
      return errorResponse(
        "invalid_tool_args",
        validation?.ok === false
          ? validation.message
          : "当前工具不支持修改参数。",
        400,
      );
    }

    const updatedAction = await updatePendingActionArgs(scope, {
      actionId: action.actionId,
      args: validation.value,
      threadId: action.threadId,
    });
    if (!updatedAction) {
      return errorResponse(
        "approval_not_pending",
        "确认请求已被其他操作处理，不能修改参数。",
        409,
      );
    }
    action = updatedAction;
  }

  if (
    normalized.value.decision === "reject" ||
    normalized.value.decision === "guidance"
  ) {
    const decidedAction = await decidePendingAction(scope, {
      actionId: action.actionId,
      approved: false,
      reason:
        normalized.value.guidance ?? normalized.value.reason,
      threadId: action.threadId,
    });
    if (!decidedAction) {
      return errorResponse(
        "approval_not_found",
        "确认请求不存在或不属于当前租户/用户/workspace/thread。",
        404,
      );
    }
    if (decidedAction.status === "expired") {
      const response = createExpiredApprovalResponse(decidedAction);
      const expiredAction = await markPendingActionExpired(scope, {
        actionId: decidedAction.actionId,
        result: response,
        threadId: decidedAction.threadId,
      });
      if (expiredAction) {
        await persistApprovalText({ action: decidedAction, response, scope });
      } else if (decidedAction.result) {
        return Response.json(decidedAction.result, { status: 409 });
      }
      return Response.json(response, { status: 409 });
    }
    if (decidedAction.status === "executing") {
      return errorResponse(
        "approval_execution_in_progress",
        "该确认请求正在执行，请勿重复提交。",
        409,
      );
    }
    if (decidedAction.status !== "rejected") {
      return errorResponse(
        "approval_not_pending",
        `确认请求当前状态为 ${decidedAction.status}，不能拒绝。`,
        409,
      );
    }
    if (decidedAction.result) {
      return Response.json(decidedAction.result);
    }

    const response = createRejectedApprovalResponse({
      action: decidedAction,
      decision: normalized.value.decision,
      guidance: normalized.value.guidance,
      reason: normalized.value.reason,
    });
    const rejectedAction = await markPendingActionRejected(scope, {
      actionId: decidedAction.actionId,
      result: response,
      threadId: decidedAction.threadId,
    });
    if (!rejectedAction) {
      const latestAction = await getPendingActionForScope(scope, {
        actionId: decidedAction.actionId,
        threadId: decidedAction.threadId,
      });
      if (latestAction?.result) {
        return Response.json(latestAction.result);
      }
      return errorResponse(
        "approval_not_pending",
        "确认请求已被其他操作处理，不能重复拒绝。",
        409,
      );
    }
    await persistApprovalText({ action: decidedAction, response, scope });
    requestLogger.info(
      {
        decision: normalized.value.decision,
        durationMs: Date.now() - requestStartedAt,
        status: response.status,
      },
      "approval action rejected",
    );
    return Response.json(response);
  }

  const decidedAction = await decidePendingAction(scope, {
    actionId: action.actionId,
    approved: true,
    reason: normalized.value.reason,
    threadId: action.threadId,
  });
  if (!decidedAction) {
    return errorResponse(
      "approval_not_found",
      "确认请求不存在或不属于当前租户/用户/workspace/thread。",
      404,
    );
  }

  if (decidedAction.status === "expired") {
    const response = createExpiredApprovalResponse(decidedAction);
    const expiredAction = await markPendingActionExpired(scope, {
      actionId: decidedAction.actionId,
      result: response,
      threadId: decidedAction.threadId,
    });
    if (expiredAction) {
      await persistApprovalText({ action: decidedAction, response, scope });
    } else if (decidedAction.result) {
      return Response.json(decidedAction.result, { status: 409 });
    }
    return Response.json(response, { status: 409 });
  }

  if (decidedAction.status !== "approved") {
    return errorResponse(
      "approval_not_pending",
      `确认请求当前状态为 ${decidedAction.status}，不能执行。`,
      409,
    );
  }

  const claimedAction = await claimPendingActionExecution(scope, {
    actionId: decidedAction.actionId,
    threadId: decidedAction.threadId,
  });
  if (!claimedAction) {
    const latestAction = await getPendingActionForScope(scope, {
      actionId: decidedAction.actionId,
      threadId: decidedAction.threadId,
    });
    if (latestAction?.result && isTerminalStatus(latestAction.status)) {
      return Response.json(latestAction.result);
    }
    if (latestAction?.status === "executing") {
      return errorResponse(
        "approval_execution_in_progress",
        "该确认请求正在执行，请勿重复提交。",
        409,
      );
    }
    return errorResponse(
      "approval_execution_unavailable",
      "确认请求已过期或无法领取执行权。",
      409,
    );
  }

  const response = await executeApprovedAction(claimedAction, threadScope);
  if (response.ok) {
    await markPendingActionExecuted(scope, {
      actionId: claimedAction.actionId,
      result: response,
      threadId: claimedAction.threadId,
    });
  } else {
    await markPendingActionFailed(scope, {
      actionId: claimedAction.actionId,
      result: response,
      threadId: claimedAction.threadId,
    });
  }
  await persistApprovalText({ action: claimedAction, response, scope });

  requestLogger.info(
    {
      decision: normalized.value.decision,
      durationMs: Date.now() - requestStartedAt,
      status: response.status,
      toolName: claimedAction.toolName,
    },
    "approval action executed",
  );

  return Response.json(response);
}

async function executeApprovedAction(
  action: StoredPendingAction,
  threadScope: ThreadScope,
): Promise<ApprovalExecutionResponse> {
  const result = await executeApprovalTool({
    args: action.args,
    context: {
      threadId: action.threadId,
      threadScope,
    },
    toolName: action.toolName,
  });
  const toolResult: ApprovalToolResult = {
    content: JSON.stringify(result),
    status: result.ok ? "success" : "error",
  };

  return createTerminalApprovalResponse({
    action,
    decision: "approve",
    finalText: result.summary,
    isError: !result.ok,
    ok: result.ok,
    status: result.ok ? "executed" : "failed",
    toolResult,
  });
}

function createRejectedApprovalResponse({
  action,
  decision,
  guidance,
  reason,
}: {
  action: StoredPendingAction;
  decision: Extract<ApprovalDecision, "guidance" | "reject">;
  guidance?: string;
  reason?: string;
}): ApprovalExecutionResponse {
  const subject = getApprovalSubject(action.toolName);
  const finalText =
    decision === "guidance"
      ? `已取消这次${subject}，不会执行原操作。已收到你的指导，请继续下一步对话。`
      : reason
        ? `已取消这次${subject}：${reason}`
        : `已取消这次${subject}。`;
  const toolResult = createToolErrorResult({
    code: "approval_rejected",
    message: reason || "The user rejected this approval request.",
    summary: finalText,
  });

  return {
    approvalId: action.actionId,
    approved: false,
    decision,
    ...(decision === "guidance" && guidance
      ? { followUpMessage: guidance }
      : {}),
    finalText,
    isError: false,
    ok: true,
    status: "rejected",
    structuredResponse: createStructuredResponse({
      finalText,
      toolName: action.toolName,
    }),
    toolCallId: action.toolCallId,
    toolName: action.toolName,
    toolResult,
  };
}

function createExpiredApprovalResponse(
  action: StoredPendingAction,
): ApprovalExecutionResponse {
  const finalText = `这次${getApprovalSubject(action.toolName)}确认已过期，请重新发起操作。`;
  return createTerminalApprovalResponse({
    action,
    decision: "reject",
    finalText,
    isError: true,
    ok: false,
    status: "expired",
    toolResult: createToolErrorResult({
      code: "approval_expired",
      message: "The approval action has expired.",
      summary: finalText,
    }),
  });
}

function createTerminalApprovalResponse({
  action,
  decision,
  finalText,
  isError,
  ok,
  status,
  toolResult,
}: {
  action: StoredPendingAction;
  decision: ApprovalDecision;
  finalText: string;
  isError: boolean;
  ok: boolean;
  status: ApprovalActionStatus;
  toolResult: ApprovalToolResult;
}): ApprovalExecutionResponse {
  return {
    approvalId: action.actionId,
    approved: status === "executed" || status === "failed",
    decision,
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
}: {
  action: StoredPendingAction;
  response: ApprovalExecutionResponse;
  scope: ThreadScope;
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
    threadId: action.threadId,
  });
}

function normalizeApprovalRequest(
  body: ApprovalRequestBody,
):
  | { ok: true; value: NormalizedApprovalRequest }
  | { code: string; message: string; ok: false; status: number } {
  const approvalId = normalizeNonEmptyString(body.approvalId);
  const threadId = normalizeNonEmptyString(body.threadId);
  if (!approvalId || !threadId) {
    return {
      code: "invalid_approval_request",
      message: "缺少 threadId 或 approvalId。",
      ok: false,
      status: 400,
    };
  }

  const decision = normalizeDecision(body);
  if (!decision) {
    return {
      code: "invalid_approval_decision",
      message: "decision 必须是 approve、reject、edit_args 或 guidance。",
      ok: false,
      status: 400,
    };
  }

  const reason = normalizeBoundedString(body.reason, MAX_REASON_LENGTH);
  const workspaceId = normalizeNonEmptyString(body.workspaceId);
  const guidance = normalizeBoundedString(body.guidance, MAX_GUIDANCE_LENGTH);
  if (body.reason !== undefined && reason === null) {
    return {
      code: "approval_reason_invalid",
      message: `reason 不能超过 ${MAX_REASON_LENGTH} 个字符。`,
      ok: false,
      status: 400,
    };
  }
  if (decision === "guidance" && !guidance) {
    return {
      code: "approval_guidance_invalid",
      message: `guidance 必须是 1-${MAX_GUIDANCE_LENGTH} 个字符。`,
      ok: false,
      status: 400,
    };
  }

  return {
    ok: true,
    value: {
      approvalId,
      ...(body.args !== undefined ? { args: body.args } : {}),
      decision,
      ...(guidance ? { guidance } : {}),
      ...(reason ? { reason } : {}),
      threadId,
      ...(workspaceId ? { workspaceId } : {}),
    },
  };
}

function normalizeDecision(body: ApprovalRequestBody): ApprovalDecision | null {
  if (
    body.decision === "approve" ||
    body.decision === "reject" ||
    body.decision === "edit_args" ||
    body.decision === "guidance"
  ) {
    return body.decision;
  }

  if (typeof body.approved === "boolean") {
    return body.approved ? "approve" : "reject";
  }

  return null;
}

function normalizeBoundedString(value: unknown, maxLength: number) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

function normalizeNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isTerminalStatus(status: ApprovalActionStatus) {
  return (
    status === "executed" ||
    status === "rejected" ||
    status === "expired" ||
    status === "failed"
  );
}

function isExpired(expiresAt: string) {
  return new Date(expiresAt).getTime() <= Date.now();
}

function errorResponse(code: string, message: string, status: number) {
  return Response.json(
    {
      error: {
        code,
        message,
      },
    },
    { status },
  );
}
