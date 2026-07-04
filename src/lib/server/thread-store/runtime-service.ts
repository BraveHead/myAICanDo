import type { ExportedMessageRepository as ExportedMessageRepositoryData } from "@assistant-ui/react";
import type { AgentMessage } from "@/lib/agent/core/agent-definition";
import type { SupportedAgent } from "@/lib/agent/shared/agent-ids";
import { isSupportedAgent } from "@/lib/agent/shared/agent-ids";
import {
  agentMessagesToRepository,
  getTitleFromAgentMessages,
  repositoryToAgentMessages,
} from "./mappers";
import {
  getThreadAgentId,
  getThreadRepositoryJson,
  saveThreadAgentId,
  saveThreadMessagesRow,
  touchThreadRow,
} from "./persistence";

export async function touchThreadFromMessages(
  threadId: string,
  messages: AgentMessage[],
) {
  const title = getTitleFromAgentMessages(messages);
  const now = new Date().toISOString();

  await touchThreadRow({
    threadId,
    title,
    updatedAt: now,
  });
}

export async function appendThreadMessages({
  agent,
  messages,
  threadId,
}: {
  agent?: SupportedAgent;
  messages: AgentMessage[];
  threadId: string;
}) {
  if (messages.length === 0) {
    return;
  }

  const storedMessages = await loadThreadAgentMessages(threadId);
  const mergedMessages = mergeAgentMessages(storedMessages, messages);
  const repository = agentMessagesToRepository(mergedMessages);
  const title = getTitleFromAgentMessages(mergedMessages);
  const now = new Date().toISOString();

  await saveThreadMessagesRow({
    agentId: agent ?? null,
    repository,
    threadId,
    title,
    updatedAt: now,
  });
}

export async function getThreadAgent(threadId: string) {
  const agent = await getThreadAgentId(threadId);
  return isSupportedAgent(agent) ? agent : undefined;
}

export async function saveThreadAgent(
  threadId: string,
  agent: SupportedAgent,
) {
  const now = new Date().toISOString();
  await saveThreadAgentId({
    agentId: agent,
    threadId,
    updatedAt: now,
  });
}

export async function loadThreadAgentMessages(threadId: string) {
  const repository = await getThreadRepositoryJson(threadId);
  if (!repository) {
    return [];
  }

  return repositoryToAgentMessages(
    repository as ExportedMessageRepositoryData,
  );
}

export function mergeAgentMessages(
  storedMessages: AgentMessage[],
  incomingMessages: AgentMessage[],
) {
  const merged = [...storedMessages];

  for (const message of incomingMessages) {
    const lastMessage = merged.at(-1);
    if (
      lastMessage?.role === message.role &&
      lastMessage.content === message.content
    ) {
      continue;
    }

    merged.push(message);
  }

  return merged;
}
