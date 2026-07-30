import { logger } from "./logger";
import {
  getPostgresPool as getRuntimePostgresPool,
  hasDatabaseUrl,
} from "./postgres-runtime";

export { hasDatabaseUrl };

export function getPostgresPool() {
  if (!hasDatabaseUrl()) {
    logger.warn({ component: "postgres" }, "DATABASE_URL is missing");
  }
  return getRuntimePostgresPool();
}
