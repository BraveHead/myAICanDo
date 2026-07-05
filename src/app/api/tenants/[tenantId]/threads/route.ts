import {
  createStoredThread,
  listStoredThreads,
} from "@/lib/server/thread-store";
import { authErrorResponse, requireTenantAccess } from "@/lib/server/saas";

type ThreadsRequestBody = {
  title?: string;
};

type ThreadsRouteContext = {
  params: Promise<{
    tenantId: string;
  }>;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: ThreadsRouteContext) {
  const access = await getRouteAccess(context);
  if (access instanceof Response) {
    return access;
  }

  return Response.json({
    threads: await listStoredThreads(toThreadScope(access)),
  });
}

export async function POST(request: Request, context: ThreadsRouteContext) {
  const access = await getRouteAccess(context);
  if (access instanceof Response) {
    return access;
  }

  let body: ThreadsRequestBody = {};

  try {
    body = (await request.json()) as ThreadsRequestBody;
  } catch {
    body = {};
  }

  return Response.json({
    thread: await createStoredThread(toThreadScope(access), normalizeTitle(body.title)),
  });
}

async function getRouteAccess(context: ThreadsRouteContext) {
  const { tenantId } = await context.params;
  try {
    return await requireTenantAccess(tenantId);
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

function toThreadScope(access: { tenantHashId: string; userHashId: string }) {
  return {
    tenantHashId: access.tenantHashId,
    userHashId: access.userHashId,
  };
}
