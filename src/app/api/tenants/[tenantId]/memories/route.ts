import {
  listMemories,
  MEMORY_KEYS,
  type MemoryKey,
  type MemoryListStatus,
} from "@/lib/server/memory-store";
import { authErrorResponse, requireTenantAccess } from "@/lib/server/saas";

type MemoriesRouteContext = {
  params: Promise<{
    tenantId: string;
  }>;
};

const MEMORY_STATUSES = [
  "active",
  "superseded",
  "deleted",
  "all",
] as const satisfies readonly MemoryListStatus[];

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: MemoriesRouteContext) {
  const access = await getRouteAccess(context);
  if (access instanceof Response) {
    return access;
  }

  const url = new URL(request.url);
  const status = getMemoryStatus(url.searchParams.get("status"));
  const memoryKey = getMemoryKey(url.searchParams.get("memoryKey"));
  if (status instanceof Response) {
    return status;
  }
  if (memoryKey instanceof Response) {
    return memoryKey;
  }

  const limit = getLimit(url.searchParams.get("limit"));
  const query = url.searchParams.get("query")?.trim() || undefined;

  return Response.json({
    memories: await listMemories(toMemoryScope(access), {
      limit,
      memoryKey,
      query,
      status,
    }),
  });
}

async function getRouteAccess(context: MemoriesRouteContext) {
  const { tenantId } = await context.params;
  try {
    return await requireTenantAccess(tenantId);
  } catch (error) {
    return authErrorResponse(error);
  }
}

function getMemoryStatus(value: string | null): MemoryListStatus | Response {
  if (!value) {
    return "active";
  }

  const status = MEMORY_STATUSES.find((candidate) => candidate === value);
  if (status) {
    return status;
  }

  return Response.json(
    {
      error: {
        code: "invalid_memory_status",
        message: "status 必须是 active、superseded、deleted 或 all。",
      },
    },
    { status: 400 },
  );
}

function getMemoryKey(value: string | null): MemoryKey | undefined | Response {
  if (!value) {
    return undefined;
  }

  const memoryKey = MEMORY_KEYS.find((candidate) => candidate === value);
  if (memoryKey) {
    return memoryKey;
  }

  return Response.json(
    {
      error: {
        code: "invalid_memory_key",
        message: "memoryKey 不是受支持的记忆键。",
      },
    },
    { status: 400 },
  );
}

function getLimit(value: string | null) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 20;
  }

  return Math.min(Math.max(Math.trunc(parsed), 1), 50);
}

function toMemoryScope(access: { tenantHashId: string; userHashId: string }) {
  return {
    tenantHashId: access.tenantHashId,
    userHashId: access.userHashId,
  };
}
