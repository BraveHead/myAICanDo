import {
  createAgent,
  createMiddleware,
  modelRetryMiddleware,
  toolRetryMiddleware,
  type AnyAgentMiddleware,
} from "langchain";
import { MemorySaver } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { ChatStreamEvent } from "@/lib/chat-stream";
import {
  DEFAULT_MODEL_TIMEOUT,
  createProjectChatModel,
  type CreateProjectChatModelOptions,
} from "./chat-model";
import { getPostgresPool, hasDatabaseUrl } from "@/lib/server/postgres";
import {
  loadThreadAgentMessages,
  mergeAgentMessages,
} from "@/lib/server/thread-store";
import type {
  AgentDefinition,
  AgentMessage,
  CreateConfiguredAgentOptions,
} from "./agent-definition";

type StreamConfiguredAgentTextOptions = CreateConfiguredAgentOptions & {
  definition: AgentDefinition;
  messages: AgentMessage[];
  onStreamEvent?: (event: ChatStreamEvent) => void;
  runConfig?: RunnableConfig;
  signal: AbortSignal;
  threadId?: string;
};

type AgentCheckpointer = MemorySaver | PostgresSaver;

let checkpointer: AgentCheckpointer | null = null;
let checkpointerPromise: Promise<AgentCheckpointer> | null = null;
const initializedAgentThreads = new Set<string>();
const AGENT_RETRY_OPTIONS = {
  maxRetries: 2,
  initialDelayMs: 600,
  backoffFactor: 2,
  maxDelayMs: 5_000,
  jitter: false,
  onFailure: "error" as const,
  retryOn: shouldRetryAgentError,
};

export async function createConfiguredAgent(
  definition: AgentDefinition,
  {
    apiKey,
    baseURL,
    modelName,
    onStreamEvent,
  }: CreateConfiguredAgentOptions & {
    onStreamEvent?: (event: ChatStreamEvent) => void;
  },
) {
  const modelOptions: CreateProjectChatModelOptions = {
    apiKey,
    baseURL,
    modelName,
    temperature: definition.modelOptions?.temperature,
    timeout: definition.modelOptions?.timeout,
  };
  const model = createProjectChatModel(modelOptions);
  const agentCheckpointer = await getAgentCheckpointer();
  const middleware = createAgentMiddleware(onStreamEvent);

  return createAgent({
    model,
    tools: definition.tools,
    systemPrompt: definition.systemPrompt,
    checkpointer: agentCheckpointer,
    ...(definition.responseFormat
      ? { responseFormat: definition.responseFormat }
      : {}),
    ...(middleware.length > 0 ? { middleware } : {}),
  });
}

export async function* streamConfiguredAgentEvents({
  definition,
  messages,
  onStreamEvent,
  runConfig,
  signal,
  threadId,
  ...modelOptions
}: StreamConfiguredAgentTextOptions) {
  const queue = createAsyncQueue<ChatStreamEvent>();
  const agent = await createConfiguredAgent(definition, {
    ...modelOptions,
    onStreamEvent: (event) => {
      onStreamEvent?.(event);
      queue.push(event);
    },
  });
  const agentCheckpointer = await getAgentCheckpointer();
  const agentThreadId = threadId
    ? createAgentThreadId(definition.id, threadId)
    : undefined;
  const invocationMessages =
    agentThreadId && threadId
      ? await getMessagesForCheckpointedRun({
          agentThreadId,
          checkpointer: agentCheckpointer,
          messages,
          threadId,
        })
      : messages;
  void runWithTimeout(
    (timeoutSignal) =>
      agent.invoke(
        { messages: invocationMessages },
        {
          ...runConfig,
          configurable: {
            ...runConfig?.configurable,
            ...(agentThreadId ? { thread_id: agentThreadId } : {}),
          },
          signal: timeoutSignal,
          recursionLimit: definition.recursionLimit ?? 8,
        },
      ),
    {
      parentSignal: signal,
      timeoutMs: definition.modelOptions?.timeout ?? DEFAULT_MODEL_TIMEOUT,
    },
  )
    .then((result) => {
      if (agentThreadId) {
        initializedAgentThreads.add(agentThreadId);
      }

      const lastMessage = result.messages.at(-1);
      const structuredResponse = getStructuredResponse(result);
      const text =
        getStructuredAnswer(structuredResponse) ??
        normalizeMessageContent(lastMessage?.content);

      if (text) {
        queue.push({ type: "text_delta", text });
      }
      if (structuredResponse !== undefined) {
        queue.push({ type: "structured_response", response: structuredResponse });
      }
      queue.close();
    })
    .catch((error: unknown) => {
      queue.fail(error);
    });

  for await (const event of queue) {
    yield event;
  }
}

export async function* streamConfiguredAgentText(
  options: StreamConfiguredAgentTextOptions,
) {
  for await (const event of streamConfiguredAgentEvents(options)) {
    if (event.type === "text_delta") {
      yield event.text;
    }
  }
}

function createToolCallStreamingMiddleware(
  onStreamEvent: (event: ChatStreamEvent) => void,
) {
  return createMiddleware({
    name: "ToolCallStreamingMiddleware",
    wrapToolCall: async (request, handler) => {
      const toolName = String(
        request.toolCall.name || request.tool?.name || "unknown_tool",
      );
      const toolCallId =
        String(request.toolCall.id || `${toolName}-${crypto.randomUUID()}`);
      const args = request.toolCall.args ?? {};

      if (isStructuredResponseTool(toolName)) {
        return handler(request);
      }

      onStreamEvent({
        type: "tool_call",
        args,
        status: "running",
        toolCallId,
        toolName,
      });

      try {
        const result = await handler(request);
        onStreamEvent({
          type: "tool_call",
          args,
          result: normalizeToolResult(result),
          status: "complete",
          toolCallId,
          toolName,
        });
        return result;
      } catch (error) {
        onStreamEvent({
          type: "tool_call",
          args,
          error: formatUnknownError(error),
          status: "error",
          toolCallId,
          toolName,
        });
        throw error;
      }
    },
  });
}

function createAgentMiddleware(
  onStreamEvent?: (event: ChatStreamEvent) => void,
): readonly AnyAgentMiddleware[] {
  const retryMiddleware = [
    toolRetryMiddleware(AGENT_RETRY_OPTIONS),
    modelRetryMiddleware(AGENT_RETRY_OPTIONS),
  ] satisfies readonly AnyAgentMiddleware[];

  if (!onStreamEvent) {
    return retryMiddleware;
  }

  return [
    createToolCallStreamingMiddleware(onStreamEvent),
    ...retryMiddleware,
    createToolRetryStatusMiddleware(onStreamEvent),
  ];
}

function createToolRetryStatusMiddleware(
  onStreamEvent: (event: ChatStreamEvent) => void,
) {
  const failedAttempts = new Map<string, number>();

  return createMiddleware({
    name: "ToolRetryStatusMiddleware",
    wrapToolCall: async (request, handler) => {
      const toolName = String(
        request.toolCall.name || request.tool?.name || "unknown_tool",
      );
      const toolCallId =
        String(request.toolCall.id || `${toolName}-${crypto.randomUUID()}`);
      const args = request.toolCall.args ?? {};

      if (isStructuredResponseTool(toolName)) {
        return handler(request);
      }

      try {
        const result = await handler(request);
        failedAttempts.delete(toolCallId);
        return result;
      } catch (error) {
        const normalizedError = toError(error);
        const attempt = (failedAttempts.get(toolCallId) ?? 0) + 1;
        failedAttempts.set(toolCallId, attempt);

        if (
          attempt <= AGENT_RETRY_OPTIONS.maxRetries &&
          shouldRetryAgentError(normalizedError)
        ) {
          onStreamEvent({
            type: "tool_call",
            args,
            retry: {
              attempt,
              error: formatUnknownError(normalizedError),
              maxRetries: AGENT_RETRY_OPTIONS.maxRetries,
              nextDelayMs: calculateRetryDelay(attempt - 1),
            },
            status: "retrying",
            toolCallId,
            toolName,
          });
        } else {
          failedAttempts.delete(toolCallId);
        }

        throw error;
      }
    },
  });
}

function calculateRetryDelay(retryNumber: number) {
  const delay =
    AGENT_RETRY_OPTIONS.backoffFactor === 0
      ? AGENT_RETRY_OPTIONS.initialDelayMs
      : AGENT_RETRY_OPTIONS.initialDelayMs *
        AGENT_RETRY_OPTIONS.backoffFactor ** retryNumber;

  return Math.min(delay, AGENT_RETRY_OPTIONS.maxDelayMs);
}

async function runWithTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  {
    parentSignal,
    timeoutMs,
  }: {
    parentSignal: AbortSignal;
    timeoutMs: number;
  },
) {
  const timeoutController = new AbortController();

  return new Promise<T>((resolve, reject) => {
    const handleAbort = () => {
      timeoutController.abort(parentSignal.reason);
      reject(new Error("请求已取消。"));
    };
    const timeoutId = setTimeout(() => {
      timeoutController.abort();
      reject(
        new Error(
          `模型调用超过 ${Math.round(
            timeoutMs / 1000,
          )} 秒未返回，请检查 OPENAI_BASE_URL 或模型服务状态。`,
        ),
      );
    }, timeoutMs);

    if (parentSignal.aborted) {
      clearTimeout(timeoutId);
      handleAbort();
      return;
    }

    parentSignal.addEventListener("abort", handleAbort, { once: true });

    run(timeoutController.signal)
      .then(resolve, reject)
      .finally(() => {
        clearTimeout(timeoutId);
        parentSignal.removeEventListener("abort", handleAbort);
      });
  });
}

async function getAgentCheckpointer() {
  if (checkpointer) {
    return checkpointer;
  }

  checkpointerPromise ??= createAgentCheckpointer();
  checkpointer = await checkpointerPromise;

  return checkpointer;
}

async function createAgentCheckpointer() {
  if (!hasDatabaseUrl()) {
    return new MemorySaver();
  }

  const postgresSaver = new PostgresSaver(getPostgresPool());
  await postgresSaver.setup();

  return postgresSaver;
}

function createAgentThreadId(agentId: AgentDefinition["id"], threadId: string) {
  return `${agentId}:${threadId}`;
}

async function getMessagesForCheckpointedRun({
  agentThreadId,
  checkpointer,
  messages,
  threadId,
}: {
  agentThreadId: string;
  checkpointer: AgentCheckpointer;
  messages: AgentMessage[];
  threadId: string;
}) {
  const checkpointExists =
    initializedAgentThreads.has(agentThreadId) ||
    Boolean(
      await checkpointer.getTuple({
        configurable: {
          thread_id: agentThreadId,
        },
      }),
    );

  if (!checkpointExists) {
    if (messages.length > 1) {
      return messages;
    }

    return mergeAgentMessages(await loadThreadAgentMessages(threadId), messages);
  }

  const latestUserMessage = messages.findLast(
    (message) => message.role === "user",
  );

  return latestUserMessage ? [latestUserMessage] : messages.slice(-1);
}

function normalizeMessageContent(content: unknown) {
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

function getStructuredResponse(result: unknown) {
  if (!result || typeof result !== "object") {
    return undefined;
  }

  if (!("structuredResponse" in result)) {
    return undefined;
  }

  return (result as { structuredResponse?: unknown }).structuredResponse;
}

function getStructuredAnswer(structuredResponse: unknown) {
  if (!structuredResponse || typeof structuredResponse !== "object") {
    return undefined;
  }

  const answer = (structuredResponse as { answer?: unknown }).answer;
  return typeof answer === "string" && answer.trim() ? answer : undefined;
}

function isStructuredResponseTool(toolName: string) {
  return toolName.startsWith("extract-");
}

function normalizeToolResult(result: unknown) {
  if (!result || typeof result !== "object") {
    return result;
  }

  const candidate = result as {
    artifact?: unknown;
    content?: unknown;
    status?: unknown;
  };

  return {
    content: candidate.content,
    ...(candidate.artifact !== undefined ? { artifact: candidate.artifact } : {}),
    ...(candidate.status !== undefined ? { status: candidate.status } : {}),
  };
}

function formatUnknownError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

function shouldRetryAgentError(error: Error) {
  const message = error.message.toLowerCase();

  return (
    error.name !== "AbortError" &&
    !message.includes("aborted") &&
    !message.includes("请求已取消")
  );
}

function createAsyncQueue<T>() {
  const values: T[] = [];
  const waiters: Array<(result: IteratorResult<T>) => void> = [];
  let closed = false;
  let failed: unknown;

  return {
    close() {
      if (closed) {
        return;
      }

      closed = true;
      while (waiters.length > 0) {
        waiters.shift()?.({ done: true, value: undefined });
      }
    },
    fail(error: unknown) {
      if (closed) {
        return;
      }

      failed = error;
      closed = true;
      while (waiters.length > 0) {
        waiters.shift()?.({ done: true, value: undefined });
      }
    },
    push(value: T) {
      if (closed) {
        return;
      }

      const waiter = waiters.shift();
      if (waiter) {
        waiter({ done: false, value });
        return;
      }

      values.push(value);
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (values.length > 0) {
          yield values.shift() as T;
          continue;
        }

        if (failed) {
          throw failed;
        }

        if (closed) {
          return;
        }

        const result = await new Promise<IteratorResult<T>>((resolve) => {
          waiters.push(resolve);
        });

        if (result.done) {
          if (failed) {
            throw failed;
          }
          return;
        }

        yield result.value;
      }
    },
  };
}
