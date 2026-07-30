import { authErrorResponse, requireTenantAccess } from "@/lib/server/saas";
import { getStoredThreadWorkspaceId } from "@/lib/server/thread-store/persistence";
import { requireWorkspaceAccess } from "@/lib/server/workspace-context";
import { getCommandExecutionThreadAccessError } from "@/lib/command-execution/access-policy";
import type { PendingActionScope } from "./pending-action-store";

export async function resolveCommandExecutionAccess({
  allowUnpersistedThread,
  tenantId,
  threadId,
  workspaceId,
}: {
  allowUnpersistedThread?: boolean;
  tenantId: string;
  threadId: string;
  workspaceId: string;
}): Promise<
  | {
      ok: true;
      scope: PendingActionScope;
    }
  | {
      ok: false;
      response: Response;
    }
> {
  let access;
  try {
    access = await requireTenantAccess(tenantId);
  } catch (error) {
    return { ok: false, response: authErrorResponse(error) };
  }

  const storedWorkspaceId = await getStoredThreadWorkspaceId(access, threadId);
  const threadAccessError = getCommandExecutionThreadAccessError({
    allowUnpersistedThread,
    requestedWorkspaceId: workspaceId,
    storedWorkspaceId,
  });
  if (threadAccessError) {
    return {
      ok: false,
      response: executionErrorResponse(
        threadAccessError.code,
        threadAccessError.message,
        threadAccessError.status,
      ),
    };
  }

  let workspaceAccess;
  try {
    workspaceAccess = await requireWorkspaceAccess(tenantId, workspaceId);
  } catch (error) {
    return { ok: false, response: authErrorResponse(error) };
  }

  return {
    ok: true,
    scope: {
      tenantHashId: access.tenantHashId,
      userHashId: access.userHashId,
      workspaceId: workspaceAccess.workspace.workspaceId,
    },
  };
}

export function executionErrorResponse(
  code: string,
  message: string,
  status: number,
) {
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

export function normalizeExecutionScopeInput(
  threadId: unknown,
  workspaceId: unknown,
) {
  if (
    typeof threadId !== "string" ||
    !threadId.trim() ||
    typeof workspaceId !== "string" ||
    !workspaceId.trim()
  ) {
    return null;
  }
  return {
    threadId: threadId.trim(),
    workspaceId: workspaceId.trim(),
  };
}
