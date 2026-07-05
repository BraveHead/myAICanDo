import { redirect } from "next/navigation";
import { getCurrentTenantAccess, getSaasSession } from "@/lib/server/saas";

export default async function Home() {
  const context = await getCurrentTenantAccess();
  if (context) {
    redirect(`/${context.tenantHashId}`);
  }

  const session = await getSaasSession();
  redirect(session ? "/switch-tenant" : "/login");
}
