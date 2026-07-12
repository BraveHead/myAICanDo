export type ClientMemoryKey =
  | "preference.answer_language"
  | "preference.answer_style"
  | "profile.current_location"
  | "profile.nickname"
  | "general";

export type ClientMemoryStatus = "active" | "superseded" | "deleted";

export type ClientMemoryListStatus = ClientMemoryStatus | "all";

export type ClientStoredMemory = {
  category: string;
  content: string;
  createdAt: string;
  memoryId: string;
  memoryKey: ClientMemoryKey;
  metadata: Record<string, unknown>;
  sourceThreadId: string | null;
  status: ClientMemoryStatus;
  supersededByMemoryId: string | null;
  updatedAt: string;
  validFrom: string;
  validTo: string | null;
};

export async function loadMemoriesFromServer(
  tenantHashId: string,
  {
    limit = 50,
    memoryKey,
    query,
    status = "active",
  }: {
    limit?: number;
    memoryKey?: ClientMemoryKey;
    query?: string;
    status?: ClientMemoryListStatus;
  } = {},
) {
  const searchParams = new URLSearchParams({
    limit: String(limit),
    status,
  });
  if (memoryKey) {
    searchParams.set("memoryKey", memoryKey);
  }
  if (query?.trim()) {
    searchParams.set("query", query.trim());
  }

  const response = await fetch(
    `${getTenantApiPath(tenantHashId, "/memories")}?${searchParams.toString()}`,
    { cache: "no-store" },
  );
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  const data = (await response.json()) as {
    memories?: ClientStoredMemory[];
  };
  return Array.isArray(data.memories) ? data.memories : [];
}

export async function deleteMemoryOnServer(
  tenantHashId: string,
  memoryId: string,
) {
  const response = await fetch(
    getTenantApiPath(tenantHashId, `/memories/${encodeURIComponent(memoryId)}`),
    { method: "DELETE" },
  );
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }
}

export async function restoreMemoryOnServer(
  tenantHashId: string,
  memoryId: string,
) {
  const response = await fetch(
    getTenantApiPath(
      tenantHashId,
      `/memories/${encodeURIComponent(memoryId)}/restore`,
    ),
    { method: "POST" },
  );
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  const data = (await response.json()) as {
    memory?: ClientStoredMemory;
  };
  return data.memory ?? null;
}

async function readErrorMessage(response: Response) {
  try {
    const data = (await response.json()) as {
      error?: { message?: string };
    };
    return data.error?.message || response.statusText;
  } catch {
    return response.statusText;
  }
}

function getTenantApiPath(tenantHashId: string, path: string) {
  return `/api/tenants/${encodeURIComponent(tenantHashId)}${path}`;
}
