import { redirect } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { requireWorkspaceAccess } from "@/lib/server/workspace-context";
import { listStoredThreads } from "@/lib/server/thread-store";
import { getThreadPath } from "@/lib/thread-routes";

type WorkspaceHomeProps = {
  params: Promise<{
    tenantId: string;
    workspaceId: string;
  }>;
};

export default async function WorkspaceHome({ params }: WorkspaceHomeProps) {
  const { tenantId, workspaceId } = await params;
  const access = await requireWorkspaceAccess(tenantId, workspaceId);
  const scope = {
    tenantHashId: access.tenantHashId,
    userHashId: access.userHashId,
    workspaceId: access.workspace.workspaceId,
  };
  const [firstThread] = await listStoredThreads(scope);

  if (!firstThread) {
    return (
      <AppShell
        tenantHashId={access.tenantHashId}
        workspaceId={access.workspace.workspaceId}
      />
    );
  }

  redirect(
    getThreadPath(
      access.tenantHashId,
      firstThread.id,
      access.workspace.workspaceId,
    ),
  );
}
