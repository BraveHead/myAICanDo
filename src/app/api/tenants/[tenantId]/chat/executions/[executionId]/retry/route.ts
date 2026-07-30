import {
  CommandExecutionStoreError,
  getCommandExecution,
  prepareCommandApprovalPreview,
  retryCommandExecution,
} from "@/lib/command-execution/execution-service";
import {
  executionErrorResponse,
  normalizeExecutionScopeInput,
  resolveCommandExecutionAccess,
} from "@/lib/server/command-execution-access";

type RouteContext = {
  params: Promise<{ executionId: string; tenantId: string }>;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: RouteContext) {
  const { executionId, tenantId } = await context.params;
  const body = await readBody(request);
  const input = normalizeExecutionScopeInput(body?.threadId, body?.workspaceId);
  if (!input) {
    return executionErrorResponse(
      "invalid_execution_scope",
      "缺少 threadId 或 workspaceId。",
      400,
    );
  }
  const access = await resolveCommandExecutionAccess({ tenantId, ...input });
  if (!access.ok) {
    return access.response;
  }

  try {
    const current = await getCommandExecution(
      access.scope,
      input.threadId,
      executionId,
    );
    if (!current) {
      return executionErrorResponse(
        "execution_not_found",
        "命令执行任务不存在或不属于当前作用域。",
        404,
      );
    }
    await prepareCommandApprovalPreview(
      {
        args: current.args,
        command: current.command,
        cwd: current.cwd,
        timeoutMs: current.timeoutMs,
      },
      {
        threadId: current.threadId,
        threadScope: access.scope,
      },
    );
    return Response.json(
      {
        commandExecution: await retryCommandExecution(access.scope, {
          executionId,
          threadId: input.threadId,
        }),
      },
      { status: 202 },
    );
  } catch (error) {
    return storeErrorResponse(error);
  }
}

async function readBody(request: Request) {
  try {
    return (await request.json()) as {
      threadId?: unknown;
      workspaceId?: unknown;
    };
  } catch {
    return null;
  }
}

function storeErrorResponse(error: unknown) {
  if (error instanceof CommandExecutionStoreError) {
    return executionErrorResponse(error.code, error.message, error.status);
  }
  return executionErrorResponse(
    "execution_retry_failed",
    error instanceof Error ? error.message : "重试命令执行失败。",
    500,
  );
}
