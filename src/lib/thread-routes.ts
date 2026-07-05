export function getThreadPath(tenantHashId: string, threadId: string) {
  return `/${encodeURIComponent(tenantHashId)}/chat/${encodeURIComponent(threadId)}`;
}
