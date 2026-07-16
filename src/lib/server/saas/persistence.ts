import "server-only";

import { getPostgresPool, hasDatabaseUrl } from "../postgres";
import type { SaasTenantRow, SaasUserRow, TenantStatus } from "./types";

let setupPromise: Promise<void> | null = null;

async function ensureSaasStore() {
  if (!hasDatabaseUrl()) {
    throw new Error("未配置 DATABASE_URL，无法使用 SaaS 租户和登录能力。");
  }

  setupPromise ??= setupSaasTables();
  await setupPromise;
}

export async function findUserByAccount(account: string) {
  await ensureSaasStore();

  const result = await getPostgresPool().query<SaasUserRow>(
    `
      SELECT
        id,
        hash_id,
        account,
        name,
        nickname,
        password_hash,
        is_active,
        joined_tenant_hash_ids,
        current_tenant_hash_id,
        created_at,
        updated_at
      FROM public.saas_users
      WHERE account = $1
      LIMIT 1
    `,
    [account],
  );

  return result.rows[0] ?? null;
}

export async function findUserByHashId(userHashId: string) {
  await ensureSaasStore();

  const result = await getPostgresPool().query<SaasUserRow>(
    `
      SELECT
        id,
        hash_id,
        account,
        name,
        nickname,
        password_hash,
        is_active,
        joined_tenant_hash_ids,
        current_tenant_hash_id,
        created_at,
        updated_at
      FROM public.saas_users
      WHERE hash_id = $1
      LIMIT 1
    `,
    [userHashId],
  );

  return result.rows[0] ?? null;
}

export async function findTenantByHashId(tenantHashId: string) {
  await ensureSaasStore();

  const result = await getPostgresPool().query<SaasTenantRow>(
    `
      SELECT id, hash_id, name, status, expires_at, created_at, updated_at
      FROM public.saas_tenants
      WHERE hash_id = $1
      LIMIT 1
    `,
    [tenantHashId],
  );

  return result.rows[0] ?? null;
}

export async function listTenantsByHashIds(tenantHashIds: string[]) {
  await ensureSaasStore();

  if (tenantHashIds.length === 0) {
    return [];
  }

  const result = await getPostgresPool().query<SaasTenantRow>(
    `
      SELECT id, hash_id, name, status, expires_at, created_at, updated_at
      FROM public.saas_tenants
      WHERE hash_id = ANY($1::text[])
      ORDER BY array_position($1::text[], hash_id)
    `,
    [tenantHashIds],
  );

  return result.rows;
}

export async function updateUserCurrentTenant({
  tenantHashId,
  userHashId,
}: {
  tenantHashId: string;
  userHashId: string;
}) {
  await ensureSaasStore();

  await getPostgresPool().query(
    `
      UPDATE public.saas_users
      SET current_tenant_hash_id = $2, updated_at = NOW()
      WHERE hash_id = $1
    `,
    [userHashId, tenantHashId],
  );
}

async function setupSaasTables() {
  const pool = getPostgresPool();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.saas_tenants (
      id BIGSERIAL PRIMARY KEY,
      hash_id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'expiring_soon', 'expired', 'trial')),
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.saas_users (
      id BIGSERIAL PRIMARY KEY,
      hash_id TEXT NOT NULL UNIQUE,
      account TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      nickname TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT true,
      joined_tenant_hash_ids TEXT[] NOT NULL DEFAULT '{}',
      current_tenant_hash_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export function isAccessibleTenantStatus(status: TenantStatus) {
  return status === "active" || status === "expiring_soon" || status === "trial";
}
