import { Pool } from "pg";
import { logger } from "./logger";

let pool: Pool | null = null;

export function hasDatabaseUrl() {
  return Boolean(process.env.DATABASE_URL?.trim());
}

function getDatabaseUrl() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    logger.warn(
      {
        component: "postgres",
      },
      "DATABASE_URL is missing",
    );
    throw new Error("未配置 DATABASE_URL，无法使用 PostgreSQL 持久化。");
  }

  return databaseUrl;
}

export function getPostgresPool() {
  if (!pool) {
    logger.info(
      {
        component: "postgres",
      },
      "initializing PostgreSQL pool",
    );
    pool = new Pool({
      connectionString: getDatabaseUrl(),
    });
  }

  return pool;
}
