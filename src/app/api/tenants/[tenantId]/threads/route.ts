import {
  createStoredThread,
  listStoredThreads,
} from "@/lib/server/thread-store";
import { authErrorResponse } from "@/lib/server/saas";
import { requireWorkspaceAccess } from "@/lib/server/workspace-context";

type ThreadsRequestBody = {
  title?: string;
  workspaceId?: string;
};

type ThreadsRouteContext = {
  params: Promise<{
    tenantId: string;
  }>;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: ThreadsRouteContext) {
  const workspaceId = new URL(request.url).searchParams.get("workspaceId") ?? undefined;
  const access = await getRouteAccess(context, workspaceId);
  if (access instanceof Response) {
    return access;
  }

  return Response.json({
    threads: await listStoredThreads(toThreadScope(access)),
  });
}

export async function POST(request: Request, context: ThreadsRouteContext) {
  const body = await readBody(request);
  const access = await getRouteAccess(context, body.workspaceId);
  if (access instanceof Response) {
    return access;
  }

  return Response.json({
    thread: await createStoredThread(toThreadScope(access), normalizeTitle(body.title)),
  });
}

async function getRouteAccess(context: ThreadsRouteContext, workspaceId?: string) {
  const { tenantId } = await context.params;
  try {
    return await requireWorkspaceAccess(tenantId, workspaceId);
  } catch (error) {
    return authErrorResponse(error);
  }
}

function normalizeTitle(title: unknown) {
  if (typeof title !== "string") {
    return "New Chat";
  }

  const normalizedTitle = title.replace(/\s+/g, " ").trim();
  return normalizedTitle || "New Chat";
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

async function readBody(request: Request): Promise<ThreadsRequestBody> {
  try {
    return (await request.json()) as ThreadsRequestBody;
  } catch {
    return {};
  }
}
