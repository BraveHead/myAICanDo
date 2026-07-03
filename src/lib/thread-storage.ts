import type {
  ExportedMessageRepository,
  ThreadMessage,
} from "@assistant-ui/react";
import type { StoredThread } from "@/lib/thread-types";

export type { StoredThread } from "@/lib/thread-types";

let activeThreadId: string | null = null;

export function createTransientThread(title = "New Chat") {
  return createClientThread(title);
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

export function loadActiveThreadId() {
  return activeThreadId;
}

export function saveActiveThreadId(threadId: string | null) {
  activeThreadId = threadId;
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

function createClientThread(title: string): StoredThread {
  const now = new Date().toISOString();

  return {
    id: createId(),
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
