import {
  CommandExecutionStoreError,
  requestCommandExecutionCancel,
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
    return Response.json({
      commandExecution: await requestCommandExecutionCancel(
        access.scope,
        input.threadId,
        executionId,
      ),
    });
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
    "execution_cancel_failed",
    "取消命令执行失败。",
    500,
  );
}
