import type { ExportedMessageRepository as ExportedMessageRepositoryData } from "@assistant-ui/react";
import type { StoredThread } from "@/lib/thread-types";
import {
  createThreadFromRepository,
  toStoredThread,
} from "./mappers";
import {
  createThreadRow,
  getThreadRepositoryJson,
  listThreadRows,
  saveThreadRepositoryJson,
} from "./persistence";

export async function listStoredThreads() {
  const rows = await listThreadRows();
  return rows.map(toStoredThread);
}

export async function createStoredThread(title = "New Chat") {
  const now = new Date().toISOString();
  const thread: StoredThread = {
    id: crypto.randomUUID(),
    title,
    createdAt: now,
    updatedAt: now,
    status: "regular",
  };

  await createThreadRow({
    createdAt: thread.createdAt,
    status: thread.status,
    threadId: thread.id,
    title: thread.title,
    updatedAt: thread.updatedAt,
  });

  return thread;
}

export async function getThreadRepository(threadId: string) {
  return (
    (await getThreadRepositoryJson(threadId)) as
      | ExportedMessageRepositoryData
      | null
  );
}

export async function saveThreadRepository({
  thread,
  threadId,
  repository,
}: {
  thread?: StoredThread;
  threadId: string;
  repository: ExportedMessageRepositoryData;
}) {
  const fallbackThread = createThreadFromRepository(threadId, repository);
  const nextThread = thread ?? fallbackThread;

  await saveThreadRepositoryJson({
    createdAt: nextThread.createdAt,
    repository,
    status: nextThread.status,
    threadId,
    title: nextThread.title,
    updatedAt: nextThread.updatedAt,
  });
}
