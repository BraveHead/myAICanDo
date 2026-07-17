import {
  authErrorResponse,
  requireTenantAccess,
} from "@/lib/server/saas";
import {
  createWorkspace,
  ensureDefaultWorkspace,
  listWorkspaces,
} from "@/lib/server/workspace-store";

type WorkspacesRouteContext = {
  params: Promise<{
    tenantId: string;
  }>;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: WorkspacesRouteContext) {
  try {
    const { tenantId } = await context.params;
    const access = await requireTenantAccess(tenantId);
    const defaultWorkspace = await ensureDefaultWorkspace(
      access.tenantHashId,
      access.userHashId,
    );
    const workspaces = await listWorkspaces(access.tenantHashId);

    return Response.json({
      defaultWorkspaceId: defaultWorkspace.workspaceId,
      workspaces: workspaces.map(toWorkspaceResponse),
    });
  } catch (error) {
    return authErrorResponse(error);
  }
}

export async function POST(request: Request, context: WorkspacesRouteContext) {
  try {
    const { tenantId } = await context.params;
    const access = await requireTenantAccess(tenantId);
    await ensureDefaultWorkspace(access.tenantHashId, access.userHashId);
    const body = await readJson(request);
    const result = await createWorkspace(
      access.tenantHashId,
      access.userHashId,
      typeof body.name === "string" ? body.name : "",
    );

    if (!result.ok) {
      return Response.json(
        { error: result.error },
        {
          status:
            result.error.code === "workspace_name_conflict" ? 409 : 400,
        },
      );
    }

    return Response.json(
      { workspace: toWorkspaceResponse(result.workspace) },
      { status: 201 },
    );
  } catch (error) {
    return authErrorResponse(error);
  }
}

async function readJson(request: Request) {
  try {
    const value = (await request.json()) as unknown;
    return value && typeof value === "object" ? (value as { name?: unknown }) : {};
  } catch {
    return {};
  }
}

function toWorkspaceResponse(workspace: Awaited<ReturnType<typeof ensureDefaultWorkspace>>) {
  return {
    name: workspace.name,
    status: workspace.status,
    workspaceId: workspace.workspaceId,
  };
}
