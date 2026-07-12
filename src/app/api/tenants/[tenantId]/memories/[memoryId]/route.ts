import { deleteMemory } from "@/lib/server/memory-store";
import { authErrorResponse, requireTenantAccess } from "@/lib/server/saas";

type MemoryRouteContext = {
  params: Promise<{
    memoryId: string;
    tenantId: string;
  }>;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(_request: Request, context: MemoryRouteContext) {
  const access = await getRouteAccess(context);
  if (access instanceof Response) {
    return access;
  }

  const { memoryId } = await context.params;
  const deleted = await deleteMemory(toMemoryScope(access), memoryId);
  if (!deleted) {
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

  return Response.json({ ok: true });
}

async function getRouteAccess(context: MemoryRouteContext) {
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
