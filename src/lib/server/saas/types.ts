export type TenantStatus = "active" | "expiring_soon" | "expired" | "trial";

export type SaasTenantRow = {
  id: string | number;
  hash_id: string;
  name: string;
  status: TenantStatus;
  expires_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

export type SaasUserRow = {
  id: string | number;
  hash_id: string;
  account: string;
  name: string;
  nickname: string;
  password_hash: string;
  is_active: boolean;
  joined_tenant_hash_ids: string[];
  current_tenant_hash_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

export type SaasTenant = {
  hashId: string;
  name: string;
  status: TenantStatus;
  expiresAt: string | null;
};

export type SaasUser = {
  hashId: string;
  account: string;
  name: string;
  nickname: string;
  isActive: boolean;
  joinedTenantHashIds: string[];
  currentTenantHashId: string | null;
};

export type TenantAccessContext = {
  tenant: SaasTenant;
  tenantHashId: string;
  user: SaasUser;
  userHashId: string;
};

export type TenantSwitcherOption = SaasTenant & {
  isAvailable: boolean;
  isCurrent: boolean;
};

export type TenantSwitcherData = {
  currentTenantHashId: string | null;
  options: TenantSwitcherOption[];
  user: SaasUser;
};

export function toSaasTenant(row: SaasTenantRow): SaasTenant {
  return {
    hashId: row.hash_id,
    name: row.name,
    status: row.status,
    expiresAt: row.expires_at ? toIsoString(row.expires_at) : null,
  };
}

export function toSaasUser(row: SaasUserRow): SaasUser {
  return {
    hashId: row.hash_id,
    account: row.account,
    name: row.name,
    nickname: row.nickname,
    isActive: row.is_active,
    joinedTenantHashIds: row.joined_tenant_hash_ids ?? [],
    currentTenantHashId: row.current_tenant_hash_id,
  };
}

function toIsoString(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
