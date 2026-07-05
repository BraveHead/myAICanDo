import { AppShell } from "@/components/app-shell";

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

  return <AppShell initialThreadId={threadId} tenantHashId={tenantId} />;
}
