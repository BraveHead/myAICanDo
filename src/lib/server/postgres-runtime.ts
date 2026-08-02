import { Pool } from "pg";

let pool: Pool | null = null;

export function hasDatabaseUrl() {
  return Boolean(process.env.DATABASE_URL?.trim());
}

export function getPostgresPool() {
  if (!pool) {
    const databaseUrl = process.env.DATABASE_URL?.trim();
    if (!databaseUrl) {
      throw new Error("未配置 DATABASE_URL，无法使用 PostgreSQL 持久化。");
    }
    pool = new Pool({
      connectionString: databaseUrl,
    });
  }
  return pool;
}

export async function closePostgresPool() {
  const currentPool = pool;
  pool = null;
  await currentPool?.end();
}
