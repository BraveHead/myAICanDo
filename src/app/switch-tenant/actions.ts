"use server";

import { redirect } from "next/navigation";
import {
  logoutCurrentUser,
  SaasAuthError,
  switchTenant,
} from "@/lib/server/saas";

export async function switchTenantAction(_state: unknown, formData: FormData) {
  const tenantHashId = String(formData.get("tenantHashId") ?? "").trim();
  if (!tenantHashId) {
    return {
      message: "请选择要切换的租户。",
    };
  }

  let nextTenantHashId: string;
  try {
    const tenant = await switchTenant(tenantHashId);
    nextTenantHashId = tenant.hashId;
  } catch (error) {
    return {
      message:
        error instanceof SaasAuthError || error instanceof Error
          ? error.message
          : "切换租户失败，请稍后重试。",
    };
  }

  redirect(`/${nextTenantHashId}`);
}

export async function logoutAction() {
  await logoutCurrentUser();
  redirect("/login");
}
