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
  type ThreadScope,
} from "./persistence";

export async function listStoredThreads(scope: ThreadScope) {
  const rows = await listThreadRows(scope);
  return rows.map(toStoredThread);
}

export async function createStoredThread(scope: ThreadScope, title = "New Chat") {
  const now = new Date().toISOString();
  const thread: StoredThread = {
    id: crypto.randomUUID(),
    title,
    createdAt: now,
    updatedAt: now,
    status: "regular",
  };

  await createThreadRow(scope, {
    createdAt: thread.createdAt,
    status: thread.status,
    threadId: thread.id,
    title: thread.title,
    updatedAt: thread.updatedAt,
  });

  return thread;
}

export async function getThreadRepository(
  scope: ThreadScope,
  threadId: string,
) {
  return (
    (await getThreadRepositoryJson(scope, threadId)) as
      | ExportedMessageRepositoryData
      | null
  );
}

export async function saveThreadRepository({
  scope,
  thread,
  threadId,
  repository,
}: {
  scope: ThreadScope;
  thread?: StoredThread;
  threadId: string;
  repository: ExportedMessageRepositoryData;
}) {
  const fallbackThread = createThreadFromRepository(threadId, repository);
  const nextThread = thread ?? fallbackThread;

  await saveThreadRepositoryJson(scope, {
    createdAt: nextThread.createdAt,
    repository,
    status: nextThread.status,
    threadId,
    title: nextThread.title,
    updatedAt: nextThread.updatedAt,
  });
}
