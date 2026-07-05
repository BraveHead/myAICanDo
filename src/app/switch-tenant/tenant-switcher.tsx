"use client";

import { Building2, Check, LogOut } from "lucide-react";
import { useActionState } from "react";
import type { TenantSwitcherOption } from "@/lib/server/saas/types";
import { logoutAction, switchTenantAction } from "./actions";

type SwitchTenantState = {
  message?: string;
};

const initialState: SwitchTenantState = {};

export function TenantSwitcher({
  options,
}: {
  options: TenantSwitcherOption[];
}) {
  const [state, action, pending] = useActionState(
    switchTenantAction,
    initialState,
  );

  return (
    <div className="space-y-4">
      {state.message && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm leading-6 text-red-700">
          {state.message}
        </div>
      )}

      <div className="space-y-3">
        {options.map((tenant) => (
          <form action={action} key={tenant.hashId}>
            <input name="tenantHashId" type="hidden" value={tenant.hashId} />
            <button
              className={`flex min-h-16 w-full items-center justify-between gap-4 rounded-lg border px-4 py-3 text-left transition-colors ${
                tenant.isCurrent
                  ? "border-[#111111] bg-[#f4f4f2]"
                  : "border-[#e4e4df] bg-white hover:border-[#bdbdb7]"
              } disabled:cursor-not-allowed disabled:bg-[#f7f7f5] disabled:text-[#8a8a8a]`}
              disabled={!tenant.isAvailable || pending}
              type="submit"
            >
              <span className="flex min-w-0 items-center gap-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-[#111111] text-white">
                  <Building2 size={18} />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[15px] font-semibold">
                    {tenant.name}
                  </span>
                  <span className="block truncate font-mono text-xs text-[#767676]">
                    {tenant.hashId}
                  </span>
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-2 text-sm text-[#555555]">
                {formatTenantStatus(tenant.status)}
                {tenant.isCurrent && <Check size={17} />}
              </span>
            </button>
          </form>
        ))}
      </div>

      <form action={logoutAction}>
        <button
          className="flex h-10 items-center justify-center gap-2 rounded-lg border border-[#dedede] px-4 text-sm font-medium text-[#333333] transition-colors hover:bg-[#f5f5f5]"
          type="submit"
        >
          <LogOut size={16} />
          退出登录
        </button>
      </form>
    </div>
  );
}

function formatTenantStatus(status: TenantSwitcherOption["status"]) {
  const statusMap = {
    active: "有效",
    expiring_soon: "即将过期",
    expired: "已过期",
    trial: "试用",
  } satisfies Record<TenantSwitcherOption["status"], string>;

  return statusMap[status];
}
