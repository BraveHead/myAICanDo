import type { ExportedMessageRepository } from "@assistant-ui/react";
import {
  getThreadRepository,
  saveThreadRepository,
} from "@/lib/server/thread-store";
import { authErrorResponse, requireTenantAccess } from "@/lib/server/saas";
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
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: ThreadRouteContext) {
  const access = await getRouteAccess(context);
  if (access instanceof Response) {
    return access;
  }

  const { threadId } = await context.params;

  return Response.json({
    repository: await getThreadRepository(toThreadScope(access), threadId),
  });
}

export async function PUT(request: Request, context: ThreadRouteContext) {
  const access = await getRouteAccess(context);
  if (access instanceof Response) {
    return access;
  }

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

async function getRouteAccess(context: ThreadRouteContext) {
  const { tenantId } = await context.params;
  try {
    return await requireTenantAccess(tenantId);
  } catch (error) {
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

function toThreadScope(access: { tenantHashId: string; userHashId: string }) {
  return {
    tenantHashId: access.tenantHashId,
    userHashId: access.userHashId,
  };
}
