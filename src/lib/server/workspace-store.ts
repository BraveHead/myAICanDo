import "server-only";

import { getPostgresPool, hasDatabaseUrl } from "./postgres";

export type WorkspaceStatus = "active";

export type Workspace = {
  createdAt: string;
  name: string;
  status: WorkspaceStatus;
  updatedAt: string;
  workspaceId: string;
};

export type WorkspaceScope = {
  tenantHashId: string;
  workspaceId: string;
};

type WorkspaceRow = {
  created_at: Date | string;
  name: string;
  status: string;
  updated_at: Date | string;
  workspace_id: string;
};

const DEFAULT_WORKSPACE_NAME = "默认工作区";
const MAX_WORKSPACE_NAME_LENGTH = 80;
const inMemoryWorkspaces = new Map<string, Workspace[]>();
let setupPromise: Promise<void> | null = null;

export async function listWorkspaces(tenantHashId: string) {
  if (!hasDatabaseUrl()) {
    const workspaces = inMemoryWorkspaces.get(tenantHashId) ?? [];
    if (workspaces.length === 0) {
      const workspace = createInMemoryWorkspace(DEFAULT_WORKSPACE_NAME);
      inMemoryWorkspaces.set(tenantHashId, [workspace]);
    }
    return inMemoryWorkspaces.get(tenantHashId) ?? [];
  }

  await ensureWorkspaceStore();
  const result = await getPostgresPool().query<WorkspaceRow>(
    `
      SELECT workspace_id, name, status, created_at, updated_at
      FROM public.assistant_workspaces
      WHERE tenant_hash_id = $1 AND status = 'active'
      ORDER BY created_at ASC, workspace_id ASC
    `,
    [tenantHashId],
  );

  return result.rows.map(toWorkspace);
}

export async function ensureDefaultWorkspace(
  tenantHashId: string,
  userHashId: string,
) {
  const existing = (await listWorkspaces(tenantHashId)).find(
    (workspace) => workspace.name === DEFAULT_WORKSPACE_NAME,
  );
  if (existing) {
    return existing;
  }

  if (!hasDatabaseUrl()) {
    const workspace = createInMemoryWorkspace(DEFAULT_WORKSPACE_NAME);
    inMemoryWorkspaces.set(tenantHashId, [workspace]);
    return workspace;
  }

  await ensureWorkspaceStore();
  const workspaceId = createWorkspaceId();
  const now = new Date().toISOString();
  const result = await getPostgresPool().query<WorkspaceRow>(
    `
      INSERT INTO public.assistant_workspaces (
        workspace_id,
        tenant_hash_id,
        name,
        status,
        created_by_user_hash_id,
        created_at,
        updated_at
      )
      VALUES ($1, $2, $3, 'active', $4, $5, $5)
      ON CONFLICT (tenant_hash_id, name) DO NOTHING
      RETURNING workspace_id, name, status, created_at, updated_at
    `,
    [workspaceId, tenantHashId, DEFAULT_WORKSPACE_NAME, userHashId, now],
  );

  if (result.rows[0]) {
    return toWorkspace(result.rows[0]);
  }

  const fallback = await listWorkspaces(tenantHashId);
  const defaultWorkspace = fallback.find(
    (workspace) => workspace.name === DEFAULT_WORKSPACE_NAME,
  );
  if (defaultWorkspace) {
    return defaultWorkspace;
  }

  throw new Error("无法创建默认工作区。");
}

export async function createWorkspace(
  tenantHashId: string,
  userHashId: string,
  name: string,
) {
  const normalizedName = normalizeWorkspaceName(name);
  if (!normalizedName) {
    return {
      error: {
        code: "workspace_name_invalid",
        message: "工作区名称不能为空，且不能超过 80 个字符。",
      },
      ok: false as const,
    };
  }

  if (!hasDatabaseUrl()) {
    const existing = (inMemoryWorkspaces.get(tenantHashId) ?? []).find(
      (workspace) => workspace.name === normalizedName,
    );
    if (existing) {
      return {
        error: {
          code: "workspace_name_conflict",
          message: "该工作区名称已存在。",
        },
        ok: false as const,
      };
    }

    const workspace = createInMemoryWorkspace(normalizedName);
    inMemoryWorkspaces.set(tenantHashId, [
      ...(inMemoryWorkspaces.get(tenantHashId) ?? []),
      workspace,
    ]);
    return { ok: true as const, workspace };
  }

  await ensureWorkspaceStore();
  const workspaceId = createWorkspaceId();
  const now = new Date().toISOString();
  let result;
  try {
    result = await getPostgresPool().query<WorkspaceRow>(
      `
        INSERT INTO public.assistant_workspaces (
          workspace_id,
          tenant_hash_id,
          name,
          status,
          created_by_user_hash_id,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, 'active', $4, $5, $5)
        RETURNING workspace_id, name, status, created_at, updated_at
      `,
      [workspaceId, tenantHashId, normalizedName, userHashId, now],
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      return {
        error: {
          code: "workspace_name_conflict",
          message: "该工作区名称已存在。",
        },
        ok: false as const,
      };
    }
    throw error;
  }

  return {
    ok: true as const,
    workspace: toWorkspace(result.rows[0]),
  };
}

export async function getWorkspace(
  tenantHashId: string,
  workspaceId: string,
) {
  if (!hasDatabaseUrl()) {
    return (inMemoryWorkspaces.get(tenantHashId) ?? []).find(
      (workspace) => workspace.workspaceId === workspaceId,
    );
  }

  await ensureWorkspaceStore();
  const result = await getPostgresPool().query<WorkspaceRow>(
    `
      SELECT workspace_id, name, status, created_at, updated_at
      FROM public.assistant_workspaces
      WHERE tenant_hash_id = $1 AND workspace_id = $2 AND status = 'active'
      LIMIT 1
    `,
    [tenantHashId, workspaceId],
  );

  return result.rows[0] ? toWorkspace(result.rows[0]) : undefined;
}

export async function ensureWorkspace(
  tenantHashId: string,
  userHashId: string,
  workspaceId?: string,
) {
  const defaultWorkspace = await ensureDefaultWorkspace(tenantHashId, userHashId);
  if (!workspaceId || workspaceId === defaultWorkspace.workspaceId) {
    return defaultWorkspace;
  }

  return getWorkspace(tenantHashId, workspaceId);
}

export function resetInMemoryWorkspacesForTests() {
  inMemoryWorkspaces.clear();
}

async function ensureWorkspaceStore() {
  if (!hasDatabaseUrl()) {
    return;
  }

  setupPromise ??= setupAssistantWorkspacesTable();
  await setupPromise;
}

async function setupAssistantWorkspacesTable() {
  const pool = getPostgresPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.assistant_workspaces (
      id BIGSERIAL PRIMARY KEY,
      workspace_id TEXT NOT NULL UNIQUE,
      tenant_hash_id TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active')),
      created_by_user_hash_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (tenant_hash_id, name)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS assistant_workspaces_tenant_idx
    ON public.assistant_workspaces (tenant_hash_id, created_at ASC)
  `);
}

function createInMemoryWorkspace(name: string): Workspace {
  const now = new Date().toISOString();
  return {
    createdAt: now,
    name,
    status: "active",
    updatedAt: now,
    workspaceId: createWorkspaceId(),
  };
}

function createWorkspaceId() {
  return `ws_${crypto.randomUUID()}`;
}

function normalizeWorkspaceName(name: string) {
  const normalizedName = name.replace(/\s+/g, " ").trim();
  return normalizedName.length <= MAX_WORKSPACE_NAME_LENGTH
    ? normalizedName
    : "";
}

function isUniqueViolation(error: unknown): error is { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "23505"
  );
}

function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    createdAt: toIsoString(row.created_at),
    name: row.name,
    status: "active",
    updatedAt: toIsoString(row.updated_at),
    workspaceId: row.workspace_id,
  };
}

function toIsoString(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
