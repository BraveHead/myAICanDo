import type { ExportedMessageRepository } from "@assistant-ui/react";
import {
  getThreadRepository,
  saveThreadRepository,
} from "@/lib/server/thread-store";
import { authErrorResponse } from "@/lib/server/saas";
import { requireTenantAccess } from "@/lib/server/saas/auth";
import { requireWorkspaceAccess } from "@/lib/server/workspace-context";
import { getStoredThreadWorkspaceId } from "@/lib/server/thread-store/persistence";
import type { StoredThread } from "@/lib/thread-types";

type ThreadRouteContext = {
  params: Promise<{
    tenantId: string;
    threadId: string;
  }>;
};

type ThreadRepositoryRequestBody = {
  repository?: ExportedMessageRepository;
  thread?: StoredThread;
  workspaceId?: string;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: ThreadRouteContext) {
  const access = await getRouteAccess(
    context,
    new URL(request.url).searchParams.get("workspaceId") ?? undefined,
  );
  if (access instanceof Response) {
    return access;
  }

  const { threadId } = await context.params;

  return Response.json({
    repository: await getThreadRepository(toThreadScope(access), threadId),
  });
}

export async function PUT(request: Request, context: ThreadRouteContext) {
  const { threadId } = await context.params;
  let body: ThreadRepositoryRequestBody;

  try {
    body = (await request.json()) as ThreadRepositoryRequestBody;
  } catch {
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

  const access = await getRouteAccess(context, body.workspaceId);
  if (access instanceof Response) {
    return access;
  }

  if (!body.repository) {
    return Response.json(
      {
        error: {
          code: "missing_repository",
          message: "缺少 repository。",
        },
      },
      { status: 400 },
    );
  }

  await saveThreadRepository({
    repository: body.repository,
    scope: toThreadScope(access),
    thread: isStoredThread(body.thread) ? body.thread : undefined,
    threadId,
  });

  return Response.json({ ok: true });
}

async function getRouteAccess(
  context: ThreadRouteContext,
  requestedWorkspaceId?: string,
) {
  const { tenantId, threadId } = await context.params;
  try {
    const tenantAccess = await requireTenantAccess(tenantId);
    const storedWorkspaceId = await getStoredThreadWorkspaceId(
      tenantAccess,
      threadId,
    );
    if (
      requestedWorkspaceId &&
      storedWorkspaceId &&
      requestedWorkspaceId !== storedWorkspaceId
    ) {
      throw new Error("thread_workspace_mismatch");
    }

    return await requireWorkspaceAccess(
      tenantId,
      requestedWorkspaceId ?? storedWorkspaceId ?? undefined,
    );
  } catch (error) {
    if (error instanceof Error && error.message === "thread_workspace_mismatch") {
      return Response.json(
        { error: { code: "thread_workspace_mismatch", message: "线程不属于当前工作区。" } },
        { status: 403 },
      );
    }
    return authErrorResponse(error);
  }
}

function isStoredThread(thread: unknown): thread is StoredThread {
  if (!thread || typeof thread !== "object") {
    return false;
  }

  const candidate = thread as Partial<StoredThread>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.updatedAt === "string" &&
    candidate.status === "regular"
  );
}

function toThreadScope(access: {
  tenantHashId: string;
  userHashId: string;
  workspace: { workspaceId: string };
}) {
  return {
    tenantHashId: access.tenantHashId,
    userHashId: access.userHashId,
    workspaceId: access.workspace.workspaceId,
  };
}
