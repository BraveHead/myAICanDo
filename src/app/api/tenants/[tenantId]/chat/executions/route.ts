import {
  CommandExecutionStoreError,
  listCommandExecutions,
} from "@/lib/command-execution/execution-service";
import {
  executionErrorResponse,
  normalizeExecutionScopeInput,
  resolveCommandExecutionAccess,
} from "@/lib/server/command-execution-access";

type RouteContext = {
  params: Promise<{ tenantId: string }>;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: RouteContext) {
  const { tenantId } = await context.params;
  const url = new URL(request.url);
  const input = normalizeExecutionScopeInput(
    url.searchParams.get("threadId"),
    url.searchParams.get("workspaceId"),
  );
  if (!input) {
    return executionErrorResponse(
      "invalid_execution_scope",
      "缺少 threadId 或 workspaceId。",
      400,
    );
  }

  const access = await resolveCommandExecutionAccess({
    allowUnpersistedThread: true,
    tenantId,
    ...input,
  });
  if (!access.ok) {
    return access.response;
  }

  try {
    return Response.json({
      executions: await listCommandExecutions(access.scope, input.threadId),
    });
  } catch (error) {
    return storeErrorResponse(error);
  }
}

function storeErrorResponse(error: unknown) {
  if (error instanceof CommandExecutionStoreError) {
    return executionErrorResponse(error.code, error.message, error.status);
  }
  return executionErrorResponse(
    "execution_list_failed",
    "加载命令执行任务失败。",
    500,
  );
}
