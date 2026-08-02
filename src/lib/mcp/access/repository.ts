import { getPostgresPool } from "@/lib/server/postgres-runtime";

export type McpAccessUserRecord = {
  isActive: boolean;
  joinedTenantHashIds: string[];
};

export type McpAccessTenantRecord = {
  status: string;
};

export type McpAccessWorkspaceRecord = {
  status: string;
  tenantHashId: string;
};

export type McpAccessThreadRecord = {
  workspaceId: string | null;
};

export type McpAccessRepository = {
  findTenantByHashId(
    tenantHashId: string,
  ): Promise<McpAccessTenantRecord | null>;
  findThreadByScope(input: {
    tenantHashId: string;
    threadId: string;
    userHashId: string;
  }): Promise<McpAccessThreadRecord | null>;
  findUserByHashId(
    userHashId: string,
  ): Promise<McpAccessUserRecord | null>;
  findWorkspaceById(
    workspaceId: string,
  ): Promise<McpAccessWorkspaceRecord | null>;
};

export function createPostgresMcpAccessRepository(
  poolFactory: typeof getPostgresPool = getPostgresPool,
): McpAccessRepository {
  return {
    async findTenantByHashId(tenantHashId) {
      const result = await poolFactory().query<{ status: string }>(
        `
          SELECT status
          FROM public.saas_tenants
          WHERE hash_id = $1
          LIMIT 1
        `,
        [tenantHashId],
      );

      return result.rows[0] ?? null;
    },

    async findThreadByScope({ tenantHashId, threadId, userHashId }) {
      const result = await poolFactory().query<{
        workspace_id: string | null;
      }>(
        `
          SELECT workspace_id
          FROM public.assistant_threads
          WHERE tenant_hash_id = $1
            AND user_hash_id = $2
            AND thread_id = $3
          LIMIT 1
        `,
        [tenantHashId, userHashId, threadId],
      );
      const row = result.rows[0];

      return row ? { workspaceId: row.workspace_id } : null;
    },

    async findUserByHashId(userHashId) {
      const result = await poolFactory().query<{
        is_active: boolean;
        joined_tenant_hash_ids: string[] | null;
      }>(
        `
          SELECT is_active, joined_tenant_hash_ids
          FROM public.saas_users
          WHERE hash_id = $1
          LIMIT 1
        `,
        [userHashId],
      );
      const row = result.rows[0];

      return row
        ? {
            isActive: row.is_active,
            joinedTenantHashIds: row.joined_tenant_hash_ids ?? [],
          }
        : null;
    },

    async findWorkspaceById(workspaceId) {
      const result = await poolFactory().query<{
        status: string;
        tenant_hash_id: string;
      }>(
        `
          SELECT tenant_hash_id, status
          FROM public.assistant_workspaces
          WHERE workspace_id = $1
          LIMIT 1
        `,
        [workspaceId],
      );
      const row = result.rows[0];

      return row
        ? {
            status: row.status,
            tenantHashId: row.tenant_hash_id,
          }
        : null;
    },
  };
}
