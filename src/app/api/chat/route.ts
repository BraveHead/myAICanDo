import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { createProjectChatModel } from "@/lib/agent/core/chat-model";
import type { AgentMessage } from "@/lib/agent/core/agent-definition";
import { resolveAgentDefinition } from "@/lib/agent/core/agent-registry";
import { streamConfiguredAgentEvents } from "@/lib/agent/core/agent-runner";
import { createLangSmithRunConfig } from "@/lib/agent/core/langsmith-tracing";
import type { SupportedAgent } from "@/lib/agent/shared/agent-ids";
import { encodeChatSseEvent, type ChatStreamEvent } from "@/lib/chat-stream";
import {
  appendThreadMessages,
  getThreadAgent,
  loadThreadAgentMessages,
  mergeAgentMessages,
  saveThreadAgent,
  touchThreadFromMessages,
} from "@/lib/server/thread-store";

type ChatRequestMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type ChatRequestBody = {
  message?: ChatRequestMessage;
  messages?: ChatRequestMessage[];
  model?: string;
  threadId?: string;
  agent?: SupportedAgent;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const threadAgentSelections = new Map<string, SupportedAgent>();

export async function POST(request: Request) {
  let body: ChatRequestBody;

  try {
    body = (await request.json()) as ChatRequestBody;
  } catch {
    return Response.json(
      {
        error: {
          code: "invalid_json",
          message: "请求体必须是合法 JSON。",
        },
      },
      { status: 400 },
    );
  }

  const messages = getRequestMessages(body);
  if (messages.length === 0) {
    return Response.json(
      {
        error: {
          code: "missing_messages",
          message: "至少需要一条消息。",
        },
      },
      { status: 400 },
    );
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return Response.json(
      {
        error: {
          code: "missing_openai_api_key",
          message: "未配置 OPENAI_API_KEY，请在 .env.local 中补充本地模型密钥。",
        },
      },
      { status: 500 },
    );
  }

  const modelName = body.model || process.env.OPENAI_MODEL || "gpt-4o-mini";
  const baseURL = process.env.OPENAI_BASE_URL || undefined;
  const threadId = resolveThreadId(body.threadId);

  const encoder = new TextEncoder();
  const agentMessages: AgentMessage[] = messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
  const messagesToAppend = getMessagesToAppend(agentMessages);
  await touchThreadFromMessages(threadId, agentMessages);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const persistedAgent = await getThreadAgent(threadId);
        const agentDefinition = resolveAgentDefinition({
          agent:
            body.agent ??
            persistedAgent ??
            threadAgentSelections.get(threadId),
          messages: agentMessages,
        });
        if (agentDefinition) {
          threadAgentSelections.set(threadId, agentDefinition.id);
          await saveThreadAgent(threadId, agentDefinition.id);
        }

        const runConfig = createLangSmithRunConfig({
          agent: agentDefinition?.id,
          modelName,
          threadId,
        });
        const events: AsyncIterable<ChatStreamEvent> =
          agentDefinition !== undefined
            ? streamConfiguredAgentEvents({
                definition: agentDefinition,
                apiKey,
                baseURL,
                modelName,
                messages: agentMessages,
                runConfig,
                signal: request.signal,
                threadId,
              })
            : streamChatModelEvents({
                model: createProjectChatModel({
                  apiKey,
                  baseURL,
                  modelName,
                }),
                messages: await getModelMessages({
                  requestMessages: agentMessages,
                  threadId,
                  usesFullHistory: Array.isArray(body.messages),
                }),
                runConfig,
                signal: request.signal,
              });

        let assistantText = "";

        for await (const event of events) {
          if (event.type === "text_delta") {
            assistantText += event.text;
          }
          controller.enqueue(encoder.encode(encodeChatSseEvent(event)));
        }

        if (assistantText) {
          await appendThreadMessages({
            agent: agentDefinition?.id,
            messages: [
              ...messagesToAppend,
              {
                role: "assistant",
                content: assistantText,
              },
            ],
            threadId,
          });
        }

        controller.close();
      } catch (error) {
        controller.enqueue(
          encoder.encode(
            encodeChatSseEvent({
              type: "text_delta",
              text: formatStreamError(error),
            }),
          ),
        );
        controller.close();
      }
    },
    cancel() {
      request.signal.throwIfAborted();
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-store",
      "Connection": "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
      "X-Thread-Id": threadId,
    },
  });
}

function getRequestMessages(body: ChatRequestBody) {
  if (Array.isArray(body.messages) && body.messages.length > 0) {
    return body.messages;
  }

  return body.message ? [body.message] : [];
}

function getMessagesToAppend(messages: AgentMessage[]) {
  const latestUserMessage = messages.findLast(
    (message) => message.role === "user",
  );

  return latestUserMessage ? [latestUserMessage] : messages.slice(-1);
}

function resolveThreadId(threadId: string | undefined) {
  const normalizedThreadId = threadId?.trim();
  return normalizedThreadId || crypto.randomUUID();
}

function formatStreamError(error: unknown) {
  if (isAbortError(error)) {
    return "请求已取消。";
  }

  if (error instanceof Error && error.message) {
    return `模型响应失败：${error.message}`;
  }

  return "模型响应失败，请检查本地模型配置或稍后重试。";
}

function isAbortError(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.message.includes("aborted"))
  );
}

async function* streamChatModelEvents({
  model,
  messages,
  runConfig,
  signal,
}: {
  model: ReturnType<typeof createProjectChatModel>;
  messages: Array<SystemMessage | AIMessage | HumanMessage>;
  runConfig: RunnableConfig;
  signal: AbortSignal;
}) {
  const chunks = await model.stream(messages, { ...runConfig, signal });

  for await (const chunk of chunks) {
    const text = normalizeChunkContent(chunk.content);
    if (text) {
      yield {
        type: "text_delta",
        text,
      } satisfies ChatStreamEvent;
    }
  }
}

async function getModelMessages({
  requestMessages,
  threadId,
  usesFullHistory,
}: {
  requestMessages: AgentMessage[];
  threadId: string;
  usesFullHistory: boolean;
}) {
  const messages = usesFullHistory
    ? requestMessages
    : mergeAgentMessages(await loadThreadAgentMessages(threadId), requestMessages);

  return messages.map((message) => {
    if (message.role === "system") {
      return new SystemMessage(message.content);
    }

    if (message.role === "assistant") {
      return new AIMessage(message.content);
    }

    return new HumanMessage(message.content);
  });
}

function normalizeChunkContent(content: unknown) {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      if (part && typeof part === "object" && "text" in part) {
        return String(part.text ?? "");
      }

      return "";
    })
    .join("");
}
