import { redirect } from "next/navigation";
import { requireTenantAccess } from "@/lib/server/saas";
import { createStoredThread, listStoredThreads } from "@/lib/server/thread-store";
import { getThreadPath } from "@/lib/thread-routes";

type TenantHomeProps = {
  params: Promise<{
    tenantId: string;
  }>;
};

export default async function TenantHome({ params }: TenantHomeProps) {
  const { tenantId } = await params;
  const access = await requireTenantAccess(tenantId);
  const scope = {
    tenantHashId: access.tenantHashId,
    userHashId: access.userHashId,
  };
  const [firstThread] = await listStoredThreads(scope);
  const thread = firstThread ?? (await createStoredThread(scope));

  redirect(getThreadPath(access.tenantHashId, thread.id));
}
