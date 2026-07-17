import { AppShell } from "@/components/app-shell";
import { requireWorkspaceAccess } from "@/lib/server/workspace-context";

type WorkspaceThreadPageProps = {
  params: Promise<{
    tenantId: string;
    workspaceId: string;
    threadId: string;
  }>;
};

export default async function WorkspaceThreadPage({
  params,
}: WorkspaceThreadPageProps) {
  const { tenantId, workspaceId, threadId } = await params;
  const access = await requireWorkspaceAccess(tenantId, workspaceId);

  return (
    <AppShell
      initialThreadId={threadId}
      tenantHashId={access.tenantHashId}
      workspaceId={access.workspace.workspaceId}
    />
  );
}
