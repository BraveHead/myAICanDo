import type { ExportedMessageRepository, ThreadMessage } from "@assistant-ui/react";
import type { StoredThread } from "@/lib/thread-types";

export type { StoredThread } from "@/lib/thread-types";

const THREADS_KEY = "myAICanDo:threads:v1";
const ACTIVE_THREAD_KEY = "myAICanDo:active-thread:v1";

export function createThread(title = "New Chat"): StoredThread {
  const now = new Date().toISOString();

  return {
    id: createId(),
    title,
    createdAt: now,
    updatedAt: now,
    status: "regular",
  };
}

export function loadThreads() {
  if (!isBrowser()) {
    return [];
  }

  try {
    const raw = localStorage.getItem(THREADS_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as StoredThread[];
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((thread) => thread.id && thread.title);
  } catch {
    return [];
  }
}

export function saveThreads(threads: StoredThread[]) {
  if (!isBrowser()) {
    return;
  }

  localStorage.setItem(THREADS_KEY, JSON.stringify(threads));
}

export async function loadThreadsFromServer() {
  try {
    const response = await fetch("/api/threads", {
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

export async function saveThreadsToServer(threads: StoredThread[]) {
  try {
    await fetch("/api/threads", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ threads }),
      keepalive: true,
    });
  } catch {
    // localStorage remains the offline fallback.
  }
}

export function loadActiveThreadId() {
  if (!isBrowser()) {
    return null;
  }

  return localStorage.getItem(ACTIVE_THREAD_KEY);
}

export function saveActiveThreadId(threadId: string) {
  if (!isBrowser()) {
    return;
  }

  localStorage.setItem(ACTIVE_THREAD_KEY, threadId);
}

export function loadRepository(threadId: string) {
  if (!isBrowser()) {
    return null;
  }

  try {
    const raw = localStorage.getItem(repositoryKey(threadId));
    if (!raw) {
      return null;
    }

    return reviveRepository(JSON.parse(raw) as ExportedMessageRepository);
  } catch {
    return null;
  }
}

export function saveRepository(
  threadId: string,
  repository: ExportedMessageRepository,
) {
  if (!isBrowser()) {
    return;
  }

  localStorage.setItem(repositoryKey(threadId), JSON.stringify(repository));
}

export async function loadRepositoryFromServer(threadId: string) {
  try {
    const response = await fetch(`/api/threads/${encodeURIComponent(threadId)}`, {
      cache: "no-store",
    });
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

export async function saveRepositoryToServer({
  repository,
  thread,
  threadId,
}: {
  repository: ExportedMessageRepository;
  thread?: StoredThread;
  threadId: string;
}) {
  try {
    await fetch(`/api/threads/${encodeURIComponent(threadId)}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ repository, thread }),
      keepalive: true,
    });
  } catch {
    // localStorage remains the offline fallback.
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

function repositoryKey(threadId: string) {
  return `myAICanDo:thread:${threadId}:messages:v1`;
}

function isBrowser() {
  return typeof window !== "undefined";
}

function createId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }

  return `thread-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
