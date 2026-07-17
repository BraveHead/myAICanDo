export function getThreadPath(
  tenantHashId: string,
  threadId: string,
  workspaceId?: string,
) {
  if (workspaceId) {
    return `/${encodeURIComponent(tenantHashId)}/workspace/${encodeURIComponent(workspaceId)}/chat/${encodeURIComponent(threadId)}`;
  }

  return `/${encodeURIComponent(tenantHashId)}/chat/${encodeURIComponent(threadId)}`;
}

export function getWorkspacePath(
  tenantHashId: string,
  workspaceId: string,
) {
  return `/${encodeURIComponent(tenantHashId)}/workspace/${encodeURIComponent(workspaceId)}`;
}

export function getNewWorkspacePath(tenantHashId: string) {
  return `/${encodeURIComponent(tenantHashId)}/workspaces/new`;
}

export function getTenantPath(tenantHashId: string) {
  return `/${encodeURIComponent(tenantHashId)}`;
}
