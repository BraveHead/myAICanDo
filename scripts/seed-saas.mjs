import { randomBytes, scryptSync } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { Pool } from "pg";

loadEnvFile(".env.local");
loadEnvFile(".env");

const databaseUrl = process.env.DATABASE_URL?.trim();

if (!databaseUrl) {
  console.error("未配置 DATABASE_URL，无法写入初始 SaaS 账号。");
  process.exit(1);
}

const seedConfig = {
  account: process.env.SAAS_SEED_ACCOUNT || "demo",
  currentTenantHashId: process.env.SAAS_SEED_TENANT_HASH_ID || "tenant_demo",
  expiredTenantHashId:
    process.env.SAAS_SEED_EXPIRED_TENANT_HASH_ID || "tenant_expired",
  name: process.env.SAAS_SEED_NAME || "Demo User",
  nickname: process.env.SAAS_SEED_NICKNAME || "Demo",
  password: process.env.SAAS_SEED_PASSWORD || "demo123456",
  tenantName: process.env.SAAS_SEED_TENANT_NAME || "Demo Tenant",
  userHashId: process.env.SAAS_SEED_USER_HASH_ID || "user_demo",
};

const pool = new Pool({
  connectionString: databaseUrl,
});

try {
  await ensureSaasTables();
  const passwordHash = hashPassword(seedConfig.password);

  await pool.query(
    `
      INSERT INTO public.saas_tenants (hash_id, name, status, expires_at)
      VALUES
        ($1, $2, 'trial', NOW() + INTERVAL '14 days'),
        ($3, 'Expired Tenant', 'expired', NOW() - INTERVAL '1 day')
      ON CONFLICT (hash_id) DO UPDATE
      SET
        name = EXCLUDED.name,
        status = EXCLUDED.status,
        expires_at = EXCLUDED.expires_at,
        updated_at = NOW()
    `,
    [
      seedConfig.currentTenantHashId,
      seedConfig.tenantName,
      seedConfig.expiredTenantHashId,
    ],
  );

  await pool.query(
    `
      INSERT INTO public.saas_users (
        hash_id,
        account,
        name,
        nickname,
        password_hash,
        is_active,
        joined_tenant_hash_ids,
        current_tenant_hash_id
      )
      VALUES ($1, $2, $3, $4, $5, true, $6::text[], $7)
      ON CONFLICT (account) DO UPDATE
      SET
        hash_id = EXCLUDED.hash_id,
        name = EXCLUDED.name,
        nickname = EXCLUDED.nickname,
        password_hash = EXCLUDED.password_hash,
        is_active = EXCLUDED.is_active,
        joined_tenant_hash_ids = EXCLUDED.joined_tenant_hash_ids,
        current_tenant_hash_id = EXCLUDED.current_tenant_hash_id,
        updated_at = NOW()
    `,
    [
      seedConfig.userHashId,
      seedConfig.account,
      seedConfig.name,
      seedConfig.nickname,
      passwordHash,
      [seedConfig.currentTenantHashId, seedConfig.expiredTenantHashId],
      seedConfig.currentTenantHashId,
    ],
  );

  console.log("SaaS 初始账号已写入。");
  console.log(`账号: ${seedConfig.account}`);
  console.log(`密码: ${seedConfig.password}`);
  console.log(`当前租户: ${seedConfig.currentTenantHashId}`);
} finally {
  await pool.end();
}

function hashPassword(password) {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64);
  return `scrypt:${salt.toString("hex")}:${key.toString("hex")}`;
}

async function ensureSaasTables() {
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

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return;
  }

  const content = readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmedLine.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmedLine.slice(0, separatorIndex).trim();
    const rawValue = trimmedLine.slice(separatorIndex + 1).trim();
    if (!key || process.env[key] !== undefined) {
      continue;
    }

    process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  }
}
