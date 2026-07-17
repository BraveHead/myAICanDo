"use client";

export type ClientWorkspace = {
  name: string;
  status: "active";
  workspaceId: string;
};

export class WorkspaceClientError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "WorkspaceClientError";
  }
}

export async function loadWorkspacesFromServer(tenantHashId: string) {
  const response = await fetch(
    `/api/tenants/${encodeURIComponent(tenantHashId)}/workspaces`,
    { cache: "no-store" },
  );
  if (!response.ok) {
    throw new Error("工作区列表加载失败。");
  }

  return (await response.json()) as {
    defaultWorkspaceId: string;
    workspaces: ClientWorkspace[];
  };
}

export async function createWorkspaceOnServer(
  tenantHashId: string,
  name: string,
) {
  const response = await fetch(
    `/api/tenants/${encodeURIComponent(tenantHashId)}/workspaces`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name }),
    },
  );
  const data = await readJson(response);

  if (!response.ok) {
    const error = isWorkspaceError(data?.error)
      ? data.error
      : {
          code: "workspace_create_failed",
          message: "工作区创建失败。",
        };
    throw new WorkspaceClientError(error.message, error.code, response.status);
  }

  if (!isClientWorkspace(data?.workspace)) {
    throw new WorkspaceClientError(
      "工作区创建响应无效。",
      "workspace_create_failed",
      response.status,
    );
  }

  return data.workspace;
}

async function readJson(response: Response) {
  try {
    return (await response.json()) as {
      error?: unknown;
      workspace?: unknown;
    };
  } catch {
    return {};
  }
}

function isWorkspaceError(value: unknown): value is {
  code: string;
  message: string;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { code?: unknown }).code === "string" &&
    typeof (value as { message?: unknown }).message === "string"
  );
}

function isClientWorkspace(value: unknown): value is ClientWorkspace {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { name?: unknown }).name === "string" &&
    (value as { status?: unknown }).status === "active" &&
    typeof (value as { workspaceId?: unknown }).workspaceId === "string"
  );
}
