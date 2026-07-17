import "server-only";

import { requireTenantAccess, SaasAuthError } from "./saas/auth";
import {
  ensureDefaultWorkspace,
  ensureWorkspace,
  type Workspace,
} from "./workspace-store";

export async function requireWorkspaceAccess(
  tenantHashId: string,
  workspaceId?: string,
) {
  const access = await requireTenantAccess(tenantHashId);
  const workspace = workspaceId
    ? await ensureWorkspace(tenantHashId, access.userHashId, workspaceId)
    : await ensureDefaultWorkspace(tenantHashId, access.userHashId);

  if (!workspace) {
    throw new SaasAuthError("工作区不存在或不属于当前租户。", "workspace_not_found", 404);
  }

  return {
    ...access,
    workspace,
  } satisfies typeof access & { workspace: Workspace };
}
