import { Pool } from "pg";

let pool: Pool | null = null;

export function hasDatabaseUrl() {
  return Boolean(process.env.DATABASE_URL?.trim());
}

export function getDatabaseUrl() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("未配置 DATABASE_URL，无法使用 PostgreSQL 持久化。");
  }

  return databaseUrl;
}

export function getPostgresPool() {
  pool ??= new Pool({
    connectionString: getDatabaseUrl(),
  });

  return pool;
}
