import { redirect } from "next/navigation";
import { getCurrentTenantAccess, getSaasSession } from "@/lib/server/saas";
import { LoginForm } from "./login-form";

export default async function LoginPage() {
  const context = await getCurrentTenantAccess();
  if (context) {
    redirect(`/${context.tenantHashId}`);
  }

  const session = await getSaasSession();
  if (session) {
    redirect("/switch-tenant");
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f7f7f5] px-5 py-10 text-[#111111]">
      <section className="w-full max-w-[420px] rounded-xl border border-[#e4e4df] bg-white p-7 shadow-[0_16px_48px_rgba(0,0,0,0.08)]">
        <div className="mb-7">
          <p className="mb-2 text-sm font-medium text-[#717171]">
            myAICanDo SaaS
          </p>
          <h1 className="text-2xl font-semibold tracking-normal">登录系统</h1>
          <p className="mt-3 text-sm leading-6 text-[#666666]">
            登录后会进入当前可用租户，过期租户不能继续访问业务页面。
          </p>
        </div>
        <LoginForm />
      </section>
    </main>
  );
}
