import { requireTenantAccess } from "@/lib/server/saas";

type TenantLayoutProps = {
  children: React.ReactNode;
  params: Promise<{
    tenantId: string;
  }>;
};

export default async function TenantLayout({
  children,
  params,
}: TenantLayoutProps) {
  const { tenantId } = await params;
  await requireTenantAccess(tenantId);

  return children;
}
