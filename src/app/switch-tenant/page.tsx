import { redirect } from "next/navigation";
import {
  getTenantSwitcherData,
  SaasAuthError,
} from "@/lib/server/saas";
import { TenantSwitcher } from "./tenant-switcher";

export default async function SwitchTenantPage() {
  let data;
  try {
    data = await getTenantSwitcherData();
  } catch (error) {
    if (error instanceof SaasAuthError && error.status === 401) {
      redirect("/login");
    }

    return (
      <main className="flex min-h-screen items-center justify-center bg-[#f7f7f5] px-5 py-10 text-[#111111]">
        <section className="w-full max-w-[520px] rounded-xl border border-[#e4e4df] bg-white p-7 shadow-[0_16px_48px_rgba(0,0,0,0.08)]">
          <h1 className="text-2xl font-semibold">租户不可用</h1>
          <p className="mt-3 text-sm leading-6 text-[#666666]">
            {error instanceof Error ? error.message : "无法读取租户信息。"}
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f7f7f5] px-5 py-10 text-[#111111]">
      <section className="w-full max-w-[560px] rounded-xl border border-[#e4e4df] bg-white p-7 shadow-[0_16px_48px_rgba(0,0,0,0.08)]">
        <div className="mb-7">
          <p className="mb-2 text-sm font-medium text-[#717171]">
            {data.user.nickname || data.user.name}
          </p>
          <h1 className="text-2xl font-semibold tracking-normal">切换租户</h1>
          <p className="mt-3 text-sm leading-6 text-[#666666]">
            只能切换到已加入且未过期的租户。切换后系统会更新当前账号正在使用的租户。
          </p>
        </div>

        {data.options.length > 0 ? (
          <TenantSwitcher options={data.options} />
        ) : (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm leading-6 text-amber-800">
            当前账号暂未加入任何租户。
          </div>
        )}
      </section>
    </main>
  );
}
