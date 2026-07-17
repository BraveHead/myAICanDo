import { redirect } from "next/navigation";
import { requireTenantAccess, SaasAuthError } from "@/lib/server/saas";
import { CreateWorkspaceForm } from "./create-workspace-form";

type NewWorkspacePageProps = {
  params: Promise<{
    tenantId: string;
  }>;
};

export default async function NewWorkspacePage({
  params,
}: NewWorkspacePageProps) {
  const { tenantId } = await params;
  let access;

  try {
    access = await requireTenantAccess(tenantId);
  } catch (error) {
    if (error instanceof SaasAuthError && error.status === 401) {
      redirect("/login");
    }

    return (
      <main className="flex min-h-dvh items-center justify-center bg-[#f7f7f5] px-5 py-10 text-[#111111]">
        <section className="w-full max-w-[560px] rounded-xl border border-[#e4e4df] bg-white p-7 shadow-[0_16px_48px_rgba(0,0,0,0.08)]">
          <h1 className="text-2xl font-semibold">工作区不可用</h1>
          <p className="mt-3 text-sm leading-6 text-[#666666]">
            {error instanceof Error ? error.message : "无法读取当前租户信息。"}
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="flex min-h-dvh items-center justify-center bg-[#f7f7f5] px-5 py-10 text-[#111111]">
      <section className="w-full max-w-[560px] rounded-xl border border-[#e4e4df] bg-white p-7 shadow-[0_16px_48px_rgba(0,0,0,0.08)]">
        <div className="mb-7">
          <p className="mb-2 text-sm font-medium text-[#717171]">
            {access.tenant.name}
          </p>
          <h1 className="text-2xl font-semibold tracking-normal">
            新建工作区
          </h1>
          <p className="mt-3 text-sm leading-6 text-[#666666]">
            工作区用于隔离对话、项目记忆和当前项目上下文。创建后可以在左侧切换。
          </p>
        </div>

        <CreateWorkspaceForm tenantHashId={access.tenantHashId} />
      </section>
    </main>
  );
}
