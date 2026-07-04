import {
  ExportedMessageRepository,
  type ExportedMessageRepository as ExportedMessageRepositoryData,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import type { AgentMessage } from "@/lib/agent/core/agent-definition";
import type { StoredThread } from "@/lib/thread-types";
import type { ThreadRow } from "./persistence";

export function toStoredThread(row: ThreadRow): StoredThread {
  return {
    id: row.thread_id,
    title: row.title,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    status: row.status,
  };
}

export function createThreadFromRepository(
  threadId: string,
  repository: ExportedMessageRepositoryData,
): StoredThread {
  const now = new Date().toISOString();
  const messages = repositoryToAgentMessages(repository);

  return {
    id: threadId,
    title: getTitleFromAgentMessages(messages),
    createdAt: now,
    updatedAt: now,
    status: "regular",
  };
}

export function repositoryToAgentMessages(
  repository: ExportedMessageRepositoryData,
) {
  if (!Array.isArray(repository.messages)) {
    return [];
  }

  return repository.messages.flatMap((item) => {
    const message = item.message;
    if (
      message.role !== "system" &&
      message.role !== "user" &&
      message.role !== "assistant"
    ) {
      return [];
    }

    const content = message.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n")
      .trim();

    if (!content) {
      return [];
    }

    return [
      {
        role: message.role,
        content,
      } satisfies AgentMessage,
    ];
  });
}

export function agentMessagesToRepository(messages: AgentMessage[]) {
  const now = Date.now();
  const items: ThreadMessageLike[] = messages.map((message, index) => ({
    role: message.role,
    content: message.content,
    createdAt: new Date(now + index),
  }));

  return ExportedMessageRepository.fromArray(items);
}

export function getTitleFromAgentMessages(messages: AgentMessage[]) {
  const firstUserText =
    messages.find((message) => message.role === "user")?.content.trim() ?? "";

  if (!firstUserText) {
    return "New Chat";
  }

  return firstUserText.length > 34
    ? `${firstUserText.slice(0, 34).trim()}...`
    : firstUserText;
}

function toIsoString(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
