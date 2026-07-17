import { redirect } from "next/navigation";
import { getStoredThreadWorkspaceId } from "@/lib/server/thread-store/persistence";
import { requireTenantAccess } from "@/lib/server/saas";
import { ensureDefaultWorkspace } from "@/lib/server/workspace-store";
import { getThreadPath } from "@/lib/thread-routes";

type TenantThreadPageProps = {
  params: Promise<{
    tenantId: string;
    threadId: string;
  }>;
};

export default async function TenantThreadPage({
  params,
}: TenantThreadPageProps) {
  const { tenantId, threadId } = await params;

  const access = await requireTenantAccess(tenantId);
  const storedWorkspaceId = await getStoredThreadWorkspaceId(access, threadId);
  const workspace = storedWorkspaceId
    ? { workspaceId: storedWorkspaceId }
    : await ensureDefaultWorkspace(access.tenantHashId, access.userHashId);

  redirect(getThreadPath(access.tenantHashId, threadId, workspace.workspaceId));
}
