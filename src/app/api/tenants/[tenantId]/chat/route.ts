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
  formatMemoriesForPrompt,
  listMemories,
  type MemoryScope,
} from "@/lib/server/memory-store";
import { createRequestLogger, toLogError } from "@/lib/server/logger";
import { authErrorResponse, requireTenantAccess } from "@/lib/server/saas";
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

type ChatRouteContext = {
  params: Promise<{
    tenantId: string;
  }>;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const threadAgentSelections = new Map<string, SupportedAgent>();
const MEMORY_CONTEXT_LIMIT = 20;
const CHAT_ROUTE = "/api/tenants/[tenantId]/chat";

export async function POST(request: Request, context: ChatRouteContext) {
  const requestStartedAt = Date.now();
  const requestId = crypto.randomUUID();
  const { tenantId } = await context.params;
  const routeLogger = createRequestLogger({
    requestId,
    route: CHAT_ROUTE,
    tenantId,
  });
  let access;

  try {
    access = await requireTenantAccess(tenantId);
  } catch (error) {
    routeLogger.warn({ err: toLogError(error) }, "chat auth failed");
    return authErrorResponse(error);
  }

  let body: ChatRequestBody;

  try {
    body = (await request.json()) as ChatRequestBody;
  } catch (error) {
    routeLogger.warn({ err: toLogError(error) }, "chat request body is invalid");
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
    routeLogger.warn("chat request missing messages");
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
    routeLogger.error("chat request missing OPENAI_API_KEY");
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
  const threadScope = {
    tenantHashId: access.tenantHashId,
    userHashId: access.userHashId,
  };
  const selectionKey = createSelectionKey(threadScope, threadId);
  const requestLogger = createRequestLogger({
    modelName,
    requestId,
    route: CHAT_ROUTE,
    tenantHashId: access.tenantHashId,
    threadId,
    userHashId: access.userHashId,
  });

  const encoder = new TextEncoder();
  const agentMessages: AgentMessage[] = messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
  const messagesToAppend = getMessagesToAppend(agentMessages);
  try {
    await touchThreadFromMessages(threadScope, threadId, agentMessages);
  } catch (error) {
    requestLogger.error(
      { err: toLogError(error) },
      "chat thread touch failed",
    );
    throw error;
  }

  requestLogger.info(
    {
      hasBaseURL: Boolean(baseURL),
      messageCount: agentMessages.length,
      requestedAgent: body.agent,
      usesFullHistory: Array.isArray(body.messages),
    },
    "chat request accepted",
  );

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let assistantText = "";

      try {
        const persistedAgent = await getThreadAgent(threadScope, threadId);
        const agentDefinition = resolveAgentDefinition({
          agent:
            body.agent ??
            persistedAgent ??
            threadAgentSelections.get(selectionKey),
          messages: agentMessages,
        });
        if (agentDefinition) {
          threadAgentSelections.set(selectionKey, agentDefinition.id);
          await saveThreadAgent(threadScope, threadId, agentDefinition.id);
        }
        const memoryContext =
          agentDefinition?.id === "memory"
            ? undefined
            : await getMemoryContext(threadScope);
        requestLogger.info(
          {
            agent: agentDefinition?.id ?? "default",
            hasMemoryContext: Boolean(memoryContext),
            persistedAgent,
          },
          "chat stream started",
        );

        const runConfig = createLangSmithRunConfig({
          agent: agentDefinition?.id,
          modelName,
          route: CHAT_ROUTE,
          tenantHashId: access.tenantHashId,
          threadId,
          userHashId: access.userHashId,
        });
        const events: AsyncIterable<ChatStreamEvent> =
          agentDefinition !== undefined
            ? streamConfiguredAgentEvents({
                definition: agentDefinition,
                apiKey,
                baseURL,
                memoryContext,
                modelName,
                messages: agentMessages,
                runConfig,
                signal: request.signal,
                threadId,
                threadScope,
              })
            : streamChatModelEvents({
                model: createProjectChatModel({
                  apiKey,
                  baseURL,
                  modelName,
                }),
                messages: await getModelMessages({
                  memoryContext,
                  requestMessages: agentMessages,
                  scope: threadScope,
                  threadId,
                  usesFullHistory: Array.isArray(body.messages),
                }),
                runConfig,
                signal: request.signal,
              });

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
            scope: threadScope,
            threadId,
          });
          requestLogger.info(
            {
              agent: agentDefinition?.id ?? "default",
              assistantTextLength: assistantText.length,
              durationMs: Date.now() - requestStartedAt,
              persistedMessageCount: messagesToAppend.length + 1,
            },
            "chat response persisted",
          );
        } else {
          requestLogger.info(
            {
              agent: agentDefinition?.id ?? "default",
              durationMs: Date.now() - requestStartedAt,
            },
            "chat response had no assistant text to persist",
          );
        }

        requestLogger.info(
          {
            agent: agentDefinition?.id ?? "default",
            assistantTextLength: assistantText.length,
            durationMs: Date.now() - requestStartedAt,
          },
          "chat stream completed",
        );
        controller.close();
      } catch (error) {
        const logPayload = {
          assistantTextLength: assistantText.length,
          durationMs: Date.now() - requestStartedAt,
          err: toLogError(error),
        };
        if (isAbortError(error)) {
          requestLogger.info(logPayload, "chat stream aborted");
        } else {
          requestLogger.error(logPayload, "chat stream failed");
        }

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
    cancel(reason) {
      requestLogger.info(
        {
          durationMs: Date.now() - requestStartedAt,
          reason: formatCancelReason(reason),
        },
        "chat stream canceled",
      );
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
      "X-Tenant-Id": access.tenantHashId,
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

function formatCancelReason(reason: unknown) {
  if (reason instanceof Error) {
    return {
      message: reason.message,
      name: reason.name,
    };
  }

  if (typeof reason === "string") {
    return reason;
  }

  return reason === undefined ? "unknown" : typeof reason;
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
  memoryContext,
  requestMessages,
  scope,
  threadId,
  usesFullHistory,
}: {
  memoryContext?: string;
  requestMessages: AgentMessage[];
  scope: { tenantHashId: string; userHashId: string };
  threadId: string;
  usesFullHistory: boolean;
}) {
  const messages = usesFullHistory
    ? requestMessages
    : mergeAgentMessages(
        await loadThreadAgentMessages(scope, threadId),
        requestMessages,
      );

  const modelMessages = messages.map((message) => {
    if (message.role === "system") {
      return new SystemMessage(message.content);
    }

    if (message.role === "assistant") {
      return new AIMessage(message.content);
    }

    return new HumanMessage(message.content);
  });

  if (!memoryContext?.trim()) {
    return modelMessages;
  }

  return [
    new SystemMessage(`已保存的用户记忆：\n\n${memoryContext}`),
    ...modelMessages,
  ];
}

async function getMemoryContext(scope: MemoryScope) {
  const memories = await listMemories(scope, {
    limit: MEMORY_CONTEXT_LIMIT,
  });

  return formatMemoriesForPrompt(memories) ?? undefined;
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

function createSelectionKey(
  scope: { tenantHashId: string; userHashId: string },
  threadId: string,
) {
  return `${scope.tenantHashId}:${scope.userHashId}:${threadId}`;
}
