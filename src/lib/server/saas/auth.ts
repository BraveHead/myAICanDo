import "server-only";

import { cache } from "react";
import { verifyPassword } from "./password";
import {
  findTenantByHashId,
  findUserByAccount,
  findUserByHashId,
  isAccessibleTenantStatus,
  listTenantsByHashIds,
  updateUserCurrentTenant,
} from "./persistence";
import { createSaasSession, deleteSaasSession, getSaasSession } from "./session";
import {
  toSaasTenant,
  toSaasUser,
  type SaasTenant,
  type SaasUser,
  type TenantAccessContext,
  type TenantSwitcherData,
} from "./types";

export class SaasAuthError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "SaasAuthError";
  }
}

export async function loginWithPassword({
  account,
  password,
}: {
  account: string;
  password: string;
}) {
  const userRow = await findUserByAccount(account);
  if (!userRow) {
    throw new SaasAuthError("账号或密码不正确。", "invalid_credentials", 401);
  }

  const passwordMatched = await verifyPassword(password, userRow.password_hash);
  if (!passwordMatched) {
    throw new SaasAuthError("账号或密码不正确。", "invalid_credentials", 401);
  }

  const user = toSaasUser(userRow);
  assertActiveUser(user);

  const tenants = (await listTenantsByHashIds(user.joinedTenantHashIds)).map(
    toSaasTenant,
  );
  const tenant = resolveLoginTenant(user, tenants);

  if (user.currentTenantHashId !== tenant.hashId) {
    await updateUserCurrentTenant({
      tenantHashId: tenant.hashId,
      userHashId: user.hashId,
    });
  }

  await createSaasSession({
    currentTenantHashId: tenant.hashId,
    userHashId: user.hashId,
  });

  return tenant;
}

export async function logoutCurrentUser() {
  await deleteSaasSession();
}

export async function switchTenant(tenantHashId: string) {
  const session = await getSaasSession();
  if (!session) {
    throw new SaasAuthError("登录会话已失效，请重新登录。", "unauthorized", 401);
  }

  const user = await getActiveUser(session.userHashId);
  assertUserJoinedTenant(user, tenantHashId);
  assertUserCurrentTenant(user, tenantHashId);

  const tenantRow = await findTenantByHashId(tenantHashId);
  if (!tenantRow) {
    throw new SaasAuthError("租户不存在。", "tenant_not_found", 404);
  }

  const tenant = toSaasTenant(tenantRow);
  assertAccessibleTenant(tenant);

  await updateUserCurrentTenant({
    tenantHashId: tenant.hashId,
    userHashId: user.hashId,
  });
  await createSaasSession({
    currentTenantHashId: tenant.hashId,
    userHashId: user.hashId,
  });

  return tenant;
}

export const getCurrentTenantAccess = cache(async () => {
  const session = await getSaasSession();
  if (!session) {
    return null;
  }

  try {
    return await getTenantAccessForSession(session.currentTenantHashId);
  } catch {
    return null;
  }
});

export async function requireTenantAccess(
  tenantHashId: string,
): Promise<TenantAccessContext> {
  const session = await getSaasSession();
  if (!session) {
    throw new SaasAuthError("登录会话已失效，请重新登录。", "unauthorized", 401);
  }

  if (session.currentTenantHashId !== tenantHashId) {
    throw new SaasAuthError(
      "当前会话租户与访问租户不一致，请先切换租户。",
      "tenant_mismatch",
      403,
    );
  }

  return getTenantAccessForSession(tenantHashId);
}

export async function getTenantSwitcherData(): Promise<TenantSwitcherData> {
  const session = await getSaasSession();
  if (!session) {
    throw new SaasAuthError("登录会话已失效，请重新登录。", "unauthorized", 401);
  }

  const user = await getActiveUser(session.userHashId);
  const tenants = (await listTenantsByHashIds(user.joinedTenantHashIds)).map(
    toSaasTenant,
  );

  return {
    currentTenantHashId: user.currentTenantHashId,
    options: tenants.map((tenant) => ({
      ...tenant,
      isAvailable: isAccessibleTenantStatus(tenant.status),
      isCurrent: tenant.hashId === user.currentTenantHashId,
    })),
    user,
  };
}

export function authErrorResponse(error: unknown) {
  if (error instanceof SaasAuthError) {
    return Response.json(
      {
        error: {
          code: error.code,
          message: error.message,
        },
      },
      { status: error.status },
    );
  }

  const message =
    error instanceof Error && error.message
      ? error.message
      : "SaaS 租户鉴权失败。";

  return Response.json(
    {
      error: {
        code: "saas_auth_failed",
        message,
      },
    },
    { status: 500 },
  );
}

async function getTenantAccessForSession(tenantHashId: string) {
  const session = await getSaasSession();
  if (!session) {
    throw new SaasAuthError("登录会话已失效，请重新登录。", "unauthorized", 401);
  }

  const user = await getActiveUser(session.userHashId);
  assertUserJoinedTenant(user, tenantHashId);

  const tenantRow = await findTenantByHashId(tenantHashId);
  if (!tenantRow) {
    throw new SaasAuthError("租户不存在。", "tenant_not_found", 404);
  }

  const tenant = toSaasTenant(tenantRow);
  assertAccessibleTenant(tenant);

  return {
    tenant,
    tenantHashId: tenant.hashId,
    user,
    userHashId: user.hashId,
  } satisfies TenantAccessContext;
}

async function getActiveUser(userHashId: string) {
  const userRow = await findUserByHashId(userHashId);
  if (!userRow) {
    throw new SaasAuthError("用户不存在或已被移除。", "user_not_found", 401);
  }

  const user = toSaasUser(userRow);
  assertActiveUser(user);
  return user;
}

function resolveLoginTenant(user: SaasUser, tenants: SaasTenant[]) {
  const currentTenant =
    user.currentTenantHashId &&
    tenants.find((tenant) => tenant.hashId === user.currentTenantHashId);
  if (currentTenant && isAccessibleTenantStatus(currentTenant.status)) {
    return currentTenant;
  }

  const firstAvailableTenant = tenants.find((tenant) =>
    isAccessibleTenantStatus(tenant.status),
  );
  if (!firstAvailableTenant) {
    throw new SaasAuthError(
      "当前账号没有可用租户，请联系管理员。",
      "no_available_tenant",
      403,
    );
  }

  return firstAvailableTenant;
}

function assertActiveUser(user: SaasUser) {
  if (!user.isActive) {
    throw new SaasAuthError("当前账号已停用。", "user_inactive", 403);
  }
}

function assertUserJoinedTenant(user: SaasUser, tenantHashId: string) {
  if (!user.joinedTenantHashIds.includes(tenantHashId)) {
    throw new SaasAuthError("当前账号未加入该租户。", "tenant_forbidden", 403);
  }
}

function assertUserCurrentTenant(user: SaasUser, tenantHashId: string) {
  if (user.currentTenantHashId !== tenantHashId) {
    throw new SaasAuthError(
      "当前访问租户不是账号正在使用的租户，请先切换租户。",
      "tenant_mismatch",
      403,
    );
  }
}

function assertAccessibleTenant(tenant: SaasTenant) {
  if (!isAccessibleTenantStatus(tenant.status)) {
    throw new SaasAuthError("当前租户已过期。", "tenant_expired", 403);
  }
}
