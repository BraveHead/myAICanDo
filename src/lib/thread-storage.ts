import type {
  ExportedMessageRepository,
  ThreadMessage,
} from "@assistant-ui/react";
import type { StoredThread } from "@/lib/thread-types";

export type { StoredThread } from "@/lib/thread-types";

const activeThreadIds = new Map<string, string | null>();

export function createTransientThread({
  threadId,
  title = "New Chat",
}: {
  threadId?: string;
  title?: string;
} = {}) {
  return createClientThread(title, threadId);
}

export async function loadThreadsFromServer(tenantHashId: string) {
  try {
    const response = await fetch(getTenantApiPath(tenantHashId, "/threads"), {
      cache: "no-store",
    });
    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as { threads?: StoredThread[] };
    return Array.isArray(data.threads) ? data.threads : [];
  } catch {
    return [];
  }
}

export function loadActiveThreadId(tenantHashId: string) {
  return activeThreadIds.get(tenantHashId) ?? null;
}

export function saveActiveThreadId(
  tenantHashId: string,
  threadId: string | null,
) {
  activeThreadIds.set(tenantHashId, threadId);
}

export async function loadRepositoryFromServer(
  tenantHashId: string,
  threadId: string,
) {
  try {
    const response = await fetch(
      getTenantApiPath(tenantHashId, `/threads/${encodeURIComponent(threadId)}`),
      {
        cache: "no-store",
      },
    );
    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as {
      repository?: ExportedMessageRepository | null;
    };
    return data.repository ? reviveRepository(data.repository) : null;
  } catch {
    return null;
  }
}

export function getThreadTitle(messages: readonly ThreadMessage[]) {
  const firstUserText = messages
    .find((message) => message.role === "user")
    ?.content.map((part) => (part.type === "text" ? part.text : ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (!firstUserText) {
    return "New Chat";
  }

  return firstUserText.length > 34
    ? `${firstUserText.slice(0, 34).trim()}...`
    : firstUserText;
}

function reviveRepository(repository: ExportedMessageRepository) {
  return {
    ...repository,
    messages: repository.messages.map((item) => ({
      ...item,
      message: {
        ...item.message,
        createdAt: new Date(item.message.createdAt),
      } as ThreadMessage,
    })),
  };
}

function createClientThread(title: string, threadId = createId()): StoredThread {
  const now = new Date().toISOString();

  return {
    id: threadId,
    title,
    createdAt: now,
    updatedAt: now,
    status: "regular",
  };
}

function createId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `thread-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getTenantApiPath(tenantHashId: string, path: string) {
  return `/api/tenants/${encodeURIComponent(tenantHashId)}${path}`;
}
