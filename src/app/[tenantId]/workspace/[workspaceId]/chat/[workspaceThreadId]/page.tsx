import { AppShell } from "@/components/app-shell";
import { requireWorkspaceAccess } from "@/lib/server/workspace-context";

type WorkspaceThreadPageProps = {
  params: Promise<{
    tenantId: string;
    workspaceId: string;
    workspaceThreadId: string;
  }>;
};

export default async function WorkspaceThreadPage({
  params,
}: WorkspaceThreadPageProps) {
  const { tenantId, workspaceId, workspaceThreadId } = await params;
  const access = await requireWorkspaceAccess(tenantId, workspaceId);

  return (
    <AppShell
      initialThreadId={workspaceThreadId}
      tenantHashId={access.tenantHashId}
      workspaceId={access.workspace.workspaceId}
    />
  );
}
