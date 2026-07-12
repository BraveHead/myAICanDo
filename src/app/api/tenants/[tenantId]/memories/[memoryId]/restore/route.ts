import { restoreMemory } from "@/lib/server/memory-store";
import { authErrorResponse, requireTenantAccess } from "@/lib/server/saas";

type RestoreMemoryRouteContext = {
  params: Promise<{
    memoryId: string;
    tenantId: string;
  }>;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: RestoreMemoryRouteContext,
) {
  const access = await getRouteAccess(context);
  if (access instanceof Response) {
    return access;
  }

  const { memoryId } = await context.params;
  const memory = await restoreMemory(toMemoryScope(access), memoryId);
  if (!memory) {
    return Response.json(
      {
        error: {
          code: "memory_not_found",
          message: "当前租户和用户下不存在这条记忆。",
        },
      },
      { status: 404 },
    );
  }

  return Response.json({ memory, ok: true });
}

async function getRouteAccess(context: RestoreMemoryRouteContext) {
  const { tenantId } = await context.params;
  try {
    return await requireTenantAccess(tenantId);
  } catch (error) {
    return authErrorResponse(error);
  }
}

function toMemoryScope(access: { tenantHashId: string; userHashId: string }) {
  return {
    tenantHashId: access.tenantHashId,
    userHashId: access.userHashId,
  };
}
