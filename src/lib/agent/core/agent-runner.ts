import {
  createAgent,
  createMiddleware,
  modelRetryMiddleware,
  toolRetryMiddleware,
  type AnyAgentMiddleware,
} from "langchain";
import type { Logger } from "pino";
import { MemorySaver } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  isApprovalGatedToolName,
  type ApprovalGatedToolName,
  type ApprovalPendingPayload,
} from "@/lib/approval-actions";
import type { ChatStreamEvent } from "@/lib/chat-stream";
import {
  DEFAULT_MODEL_TIMEOUT,
  createProjectChatModel,
  type CreateProjectChatModelOptions,
} from "./chat-model";
import { createRequestLogger, logger, toLogError } from "@/lib/server/logger";
import { createPendingAction } from "@/lib/server/pending-action-store";
import { getPostgresPool, hasDatabaseUrl } from "@/lib/server/postgres";
import {
  loadThreadAgentMessages,
  mergeAgentMessages,
} from "@/lib/server/thread-store";
import type { ThreadScope } from "@/lib/server/thread-store/persistence";
import type {
  AgentDefinition,
  AgentMessage,
  AgentToolContext,
  CreateConfiguredAgentOptions,
} from "./agent-definition";

type StreamConfiguredAgentTextOptions = CreateConfiguredAgentOptions & {
  definition: AgentDefinition;
  memoryContext?: string;
  messages: AgentMessage[];
  onStreamEvent?: (event: ChatStreamEvent) => void;
  runConfig?: RunnableConfig;
  signal: AbortSignal;
  threadId?: string;
  threadScope?: ThreadScope;
};

type AgentCheckpointer = MemorySaver | PostgresSaver;
type ToolCallStreamEvent = Extract<ChatStreamEvent, { type: "tool_call" }>;
type StructuredAgentFallbackResponse = {
  answer: string;
  confidence: number;
  keyFacts: string[];
  toolResults: Array<{
    summary: string;
    toolName: string;
  }>;
};
type FilesystemToolSummary = {
  errorCode?: string;
  event: ToolCallStreamEvent;
  isError: boolean;
  summary: string;
};
type MemoryToolSummary = {
  event: ToolCallStreamEvent;
  isError: boolean;
  summary: string;
};
type CoordinatorToolSummary = {
  event: ToolCallStreamEvent;
  isError: boolean;
  summary: string;
};

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
const FALLBACK_FILE_CONTENT_LIMIT = 4_000;
const FALLBACK_SEARCH_MATCH_LIMIT = 20;

class ToolApprovalRequiredError extends Error {
  constructor(
    public readonly pendingAction: ApprovalPendingPayload,
    public readonly userMessage: string,
  ) {
    super(userMessage);
    this.name = "ToolApprovalRequiredError";
  }
}

export async function createConfiguredAgent(
  definition: AgentDefinition,
  {
    apiKey,
    baseURL,
    memoryContext,
    modelName,
    onStreamEvent,
    runLogger,
    threadId,
    threadScope,
  }: CreateConfiguredAgentOptions & {
    memoryContext?: string;
    onStreamEvent?: (event: ChatStreamEvent) => void;
    runLogger?: Logger;
    threadId?: string;
    threadScope?: ThreadScope;
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
  const middleware = createAgentMiddleware(onStreamEvent, runLogger, {
    agentId: definition.id,
    threadId,
    threadScope,
  });
  const tools = resolveAgentTools(definition, {
    threadId,
    threadScope,
  });
  runLogger?.debug(
    {
      checkpointer: getCheckpointerType(agentCheckpointer),
      hasMemoryContext: Boolean(memoryContext),
      hasResponseFormat: Boolean(definition.responseFormat),
      toolCount: tools.length,
    },
    "agent configured",
  );

  return createAgent({
    model,
    tools,
    systemPrompt: appendSystemPromptContext(
      definition.systemPrompt,
      memoryContext,
    ),
    checkpointer: agentCheckpointer,
    ...(definition.responseFormat
      ? { responseFormat: definition.responseFormat }
      : {}),
    ...(middleware.length > 0 ? { middleware } : {}),
  });
}

export async function* streamConfiguredAgentEvents({
  definition,
  memoryContext,
  messages,
  onStreamEvent,
  runConfig,
  signal,
  threadId,
  threadScope,
  ...modelOptions
}: StreamConfiguredAgentTextOptions) {
  const queue = createAsyncQueue<ChatStreamEvent>();
  let completedToolCallCount = 0;
  const completedToolCalls: ToolCallStreamEvent[] = [];
  const runLogger = createRequestLogger({
    agent: definition.id,
    component: "agent-runner",
    hasBaseURL: Boolean(modelOptions.baseURL),
    modelName: modelOptions.modelName,
    tenantHashId: threadScope?.tenantHashId,
    threadId,
    userHashId: threadScope?.userHashId,
  });
  const agent = await createConfiguredAgent(definition, {
    ...modelOptions,
    memoryContext,
    onStreamEvent: (event) => {
      if (event.type === "tool_call" && event.status === "complete") {
        completedToolCallCount += 1;
        completedToolCalls.push(event);
      }

      onStreamEvent?.(event);
      queue.push(event);
    },
    runLogger,
    threadId,
    threadScope,
  });
  const agentCheckpointer = await getAgentCheckpointer();
  const agentThreadId = threadId
    ? createAgentThreadId(definition.id, threadId, threadScope)
    : undefined;
  const invocationMessages =
    agentThreadId && threadId && threadScope
      ? await getMessagesForCheckpointedRun({
          agentThreadId,
          checkpointer: agentCheckpointer,
          messages,
          scope: threadScope,
          threadId,
        })
      : messages;
  const recursionLimit = definition.recursionLimit ?? 8;
  const timeoutMs = definition.modelOptions?.timeout ?? DEFAULT_MODEL_TIMEOUT;
  const invokeAgent = (timeoutSignal: AbortSignal) =>
    agent.invoke(
      { messages: invocationMessages },
      {
        ...runConfig,
        configurable: {
          ...runConfig?.configurable,
          ...(agentThreadId ? { thread_id: agentThreadId } : {}),
        },
        signal: timeoutSignal,
        recursionLimit,
      },
    );
  const runAgent = () =>
    runWithTimeout(invokeAgent, {
      parentSignal: signal,
      timeoutMs,
    });
  const pushAgentResult = (result: Awaited<ReturnType<typeof invokeAgent>>) => {
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

    return {
      hasStructuredResponse: structuredResponse !== undefined,
      outputMessageCount: result.messages.length,
      textLength: text.length,
    };
  };
  const pushToolResultFallback = () => {
    const fallback = createAgentToolResultFallback(definition, completedToolCalls);
    if (!fallback) {
      return false;
    }

    if (agentThreadId) {
      initializedAgentThreads.add(agentThreadId);
    }

    queue.push({ type: "text_delta", text: fallback.answer });
    queue.push({ type: "structured_response", response: fallback });
    runLogger.warn(
      {
        completedToolCallCount,
        fallbackTextLength: fallback.answer.length,
      },
      "agent tool result fallback emitted",
    );
    queue.close();
    return true;
  };

  runLogger.info(
    {
      agentThreadId,
      checkpointer: getCheckpointerType(agentCheckpointer),
      hasMemoryContext: Boolean(memoryContext),
      invocationMessageCount: invocationMessages.length,
      recursionLimit,
      timeoutMs,
    },
    "agent invoke started",
  );

  void runAgent()
    .then((result) => {
      const resultSummary = pushAgentResult(result);
      runLogger.info(
        {
          ...resultSummary,
          completedToolCallCount,
        },
        "agent invoke completed",
      );
      queue.close();
    })
    .catch(async (error: unknown) => {
      if (isToolApprovalRequiredError(error)) {
        if (agentThreadId) {
          initializedAgentThreads.add(agentThreadId);
        }
        const structuredResponse = createApprovalPendingStructuredResponse(error);
        queue.push({ type: "text_delta", text: error.userMessage });
        queue.push({
          type: "structured_response",
          response: structuredResponse,
        });
        runLogger.info(
          {
            approvalId: error.pendingAction.actionId,
            toolCallId: error.pendingAction.toolCallId,
            toolName: error.pendingAction.toolName,
          },
          "agent invoke paused for tool approval",
        );
        queue.close();
        return;
      }

      // Tool results may already be checkpointed when the final model call fails;
      // one resume lets LangGraph finish from that persisted state.
      if (
        agentThreadId &&
        completedToolCallCount > 0 &&
        !signal.aborted &&
        shouldRetryAgentError(toError(error))
      ) {
        runLogger.warn(
          {
            completedToolCallCount,
            err: toLogError(error),
          },
          "agent invoke failed after tool call; retrying from checkpoint",
        );
        try {
          const result = await runAgent();
          const resultSummary = pushAgentResult(result);
          runLogger.info(
            {
              ...resultSummary,
              completedToolCallCount,
            },
            "agent invoke resumed from checkpoint",
          );
          queue.close();
          return;
        } catch (resumeError) {
          if (pushToolResultFallback()) {
            return;
          }

          queue.fail(resumeError);
          runLogger.error(
            {
              completedToolCallCount,
              err: toLogError(resumeError),
            },
            "agent invoke resume failed",
          );
          return;
        }
      }

      if (pushToolResultFallback()) {
        return;
      }

      queue.fail(error);
      runLogger.error(
        {
          completedToolCallCount,
          err: toLogError(error),
        },
        "agent invoke failed",
      );
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

function resolveAgentTools(
  definition: AgentDefinition,
  context: AgentToolContext,
) {
  return typeof definition.tools === "function"
    ? definition.tools(context)
    : definition.tools;
}

function appendSystemPromptContext(
  systemPrompt: string,
  memoryContext: string | undefined,
) {
  if (!memoryContext?.trim()) {
    return systemPrompt;
  }

  return `${systemPrompt}\n\n## 已保存的用户记忆\n\n${memoryContext}`;
}

function createToolCallStreamingMiddleware(
  onStreamEvent: (event: ChatStreamEvent) => void,
  runLogger?: Logger,
  approvalContext?: {
    agentId: AgentDefinition["id"];
    threadId?: string;
    threadScope?: ThreadScope;
  },
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

      if (isApprovalGatedToolName(toolName)) {
        const pendingAction = await createToolApprovalAction({
          args,
          approvalContext,
          toolCallId,
          toolName,
        });
        runLogger?.info(
          {
            approvalId: pendingAction.actionId,
            toolCallId,
            toolName,
          },
          "agent tool call requires approval",
        );
        onStreamEvent({
          type: "tool_call",
          approval: createToolApprovalPayload(pendingAction),
          args,
          status: "requires_action",
          toolCallId,
          toolName,
        });
        throw new ToolApprovalRequiredError(
          pendingAction,
          createApprovalRequiredMessage(toolName, args),
        );
      }

      runLogger?.debug(
        {
          args: summarizeLogValue(args),
          toolCallId,
          toolName,
        },
        "agent tool call started",
      );
      onStreamEvent({
        type: "tool_call",
        args,
        status: "running",
        toolCallId,
        toolName,
      });

      try {
        const result = await handler(request);
        runLogger?.debug(
          {
            result: summarizeLogValue(result),
            toolCallId,
            toolName,
          },
          "agent tool call completed",
        );
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
        runLogger?.error(
          {
            err: toLogError(error),
            toolCallId,
            toolName,
          },
          "agent tool call failed",
        );
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
  runLogger?: Logger,
  approvalContext?: {
    agentId: AgentDefinition["id"];
    threadId?: string;
    threadScope?: ThreadScope;
  },
): readonly AnyAgentMiddleware[] {
  const retryMiddleware = [
    toolRetryMiddleware(AGENT_RETRY_OPTIONS),
    modelRetryMiddleware(AGENT_RETRY_OPTIONS),
  ] satisfies readonly AnyAgentMiddleware[];

  if (!onStreamEvent) {
    return retryMiddleware;
  }

  return [
    createToolCallStreamingMiddleware(onStreamEvent, runLogger, approvalContext),
    ...retryMiddleware,
    createToolRetryStatusMiddleware(onStreamEvent, runLogger),
  ];
}

async function createToolApprovalAction({
  approvalContext,
  args,
  toolCallId,
  toolName,
}: {
  approvalContext?: {
    agentId: AgentDefinition["id"];
    threadId?: string;
    threadScope?: ThreadScope;
  };
  args: unknown;
  toolCallId: string;
  toolName: ApprovalGatedToolName;
}) {
  if (!approvalContext?.threadId || !approvalContext.threadScope) {
    throw new Error("人工确认工具需要 tenant/user/thread 上下文。");
  }

  const pendingAction = await createPendingAction(approvalContext.threadScope, {
    agentId: approvalContext.agentId,
    args,
    threadId: approvalContext.threadId,
    toolCallId,
    toolName,
  });

  if (!pendingAction) {
    throw new Error("未配置 DATABASE_URL，无法创建人工确认请求。");
  }

  return {
    actionId: pendingAction.actionId,
    agentId: approvalContext.agentId,
    args,
    toolCallId,
    toolName,
  } satisfies ApprovalPendingPayload;
}

function createToolApprovalPayload(action: ApprovalPendingPayload) {
  const actionLabel =
    action.toolName === "save_memory" ? "保存记忆" : "删除记忆";

  return {
    id: action.actionId,
    options: [
      {
        id: "approve-once",
        kind: "allow-once",
        label: `确认${actionLabel}`,
        description: "只允许本次工具调用执行。",
      },
      {
        id: "reject-once",
        kind: "reject-once",
        label: "取消",
        description: "取消本次工具调用，不修改长期记忆。",
      },
    ],
  };
}

function createApprovalRequiredMessage(
  toolName: ApprovalGatedToolName,
  args: unknown,
) {
  if (toolName === "save_memory") {
    const content =
      isRecord(args) && typeof args.content === "string"
        ? `：${args.content}`
        : "";
    return `需要你确认后才会保存这条长期记忆${content}`;
  }

  const memoryId =
    isRecord(args) && typeof args.memoryId === "string"
      ? ` ${args.memoryId}`
      : "";
  return `需要你确认后才会删除长期记忆${memoryId}。`;
}

function createApprovalPendingStructuredResponse(
  error: ToolApprovalRequiredError,
): StructuredAgentFallbackResponse {
  return {
    answer: error.userMessage,
    confidence: 1,
    keyFacts: [error.userMessage],
    toolResults: [
      {
        summary: error.userMessage,
        toolName: error.pendingAction.toolName,
      },
    ],
  };
}

function createToolRetryStatusMiddleware(
  onStreamEvent: (event: ChatStreamEvent) => void,
  runLogger?: Logger,
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
          const nextDelayMs = calculateRetryDelay(attempt - 1);
          runLogger?.warn(
            {
              attempt,
              err: toLogError(normalizedError),
              maxRetries: AGENT_RETRY_OPTIONS.maxRetries,
              nextDelayMs,
              toolCallId,
              toolName,
            },
            "agent tool call retry scheduled",
          );
          onStreamEvent({
            type: "tool_call",
            args,
            retry: {
              attempt,
              error: formatUnknownError(normalizedError),
              maxRetries: AGENT_RETRY_OPTIONS.maxRetries,
              nextDelayMs,
            },
            status: "retrying",
            toolCallId,
            toolName,
          });
        } else {
          runLogger?.error(
            {
              attempt,
              err: toLogError(normalizedError),
              maxRetries: AGENT_RETRY_OPTIONS.maxRetries,
              toolCallId,
              toolName,
            },
            "agent tool call retry exhausted",
          );
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
    logger.warn(
      {
        checkpointer: "memory",
        component: "agent-checkpointer",
      },
      "DATABASE_URL is missing; using in-memory LangGraph checkpointer",
    );
    return new MemorySaver();
  }

  logger.info(
    {
      checkpointer: "postgres",
      component: "agent-checkpointer",
    },
    "initializing Postgres LangGraph checkpointer",
  );
  const postgresSaver = new PostgresSaver(getPostgresPool());
  await postgresSaver.setup();
  logger.info(
    {
      checkpointer: "postgres",
      component: "agent-checkpointer",
    },
    "Postgres LangGraph checkpointer initialized",
  );

  return postgresSaver;
}

function getCheckpointerType(agentCheckpointer: AgentCheckpointer) {
  return agentCheckpointer instanceof PostgresSaver ? "postgres" : "memory";
}

function summarizeLogValue(value: unknown) {
  if (value === null) {
    return {
      type: "null",
    };
  }

  if (Array.isArray(value)) {
    return {
      length: value.length,
      type: "array",
    };
  }

  if (typeof value === "string") {
    return {
      length: value.length,
      type: "string",
    };
  }

  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return {
      keyCount: keys.length,
      keys: keys.slice(0, 20),
      type: "object",
    };
  }

  return {
    type: typeof value,
  };
}

function createAgentThreadId(
  agentId: AgentDefinition["id"],
  threadId: string,
  scope?: ThreadScope,
) {
  return scope
    ? `${agentId}:${scope.tenantHashId}:${scope.userHashId}:${threadId}`
    : `${agentId}:${threadId}`;
}

async function getMessagesForCheckpointedRun({
  agentThreadId,
  checkpointer,
  messages,
  scope,
  threadId,
}: {
  agentThreadId: string;
  checkpointer: AgentCheckpointer;
  messages: AgentMessage[];
  scope: ThreadScope;
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

    return mergeAgentMessages(
      await loadThreadAgentMessages(scope, threadId),
      messages,
    );
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

function createAgentToolResultFallback(
  definition: AgentDefinition,
  completedToolCalls: ToolCallStreamEvent[],
): StructuredAgentFallbackResponse | null {
  if (completedToolCalls.length === 0) {
    return null;
  }

  if (definition.id === "filesystem") {
    return createFilesystemToolResultFallback(completedToolCalls);
  }

  if (definition.id === "memory") {
    return createMemoryToolResultFallback(completedToolCalls);
  }

  if (definition.id === "coordinator") {
    return createCoordinatorToolResultFallback(completedToolCalls);
  }

  return null;
}

function createFilesystemToolResultFallback(
  completedToolCalls: ToolCallStreamEvent[],
) {
  const summaries = getUniqueToolCalls(completedToolCalls)
    .map(createFilesystemToolSummary)
    .filter((summary): summary is FilesystemToolSummary => Boolean(summary));
  const visibleSummaries = getVisibleFilesystemSummaries(summaries);

  if (visibleSummaries.length === 0) {
    return null;
  }

  return {
    answer: visibleSummaries.map((entry) => entry.summary).join("\n\n"),
    confidence: 1,
    keyFacts: visibleSummaries.map((entry) => entry.summary),
    toolResults: visibleSummaries.map((entry) => ({
      summary: entry.summary,
      toolName: entry.event.toolName,
    })),
  };
}

function createMemoryToolResultFallback(
  completedToolCalls: ToolCallStreamEvent[],
): StructuredAgentFallbackResponse | null {
  const summaries = getUniqueToolCalls(completedToolCalls)
    .map(createMemoryToolSummary)
    .filter((summary): summary is MemoryToolSummary => Boolean(summary));

  if (summaries.length === 0) {
    return null;
  }

  return {
    answer: summaries.map((entry) => entry.summary).join("\n\n"),
    confidence: 1,
    keyFacts: summaries.map((entry) => entry.summary),
    toolResults: summaries.map((entry) => ({
      summary: entry.summary,
      toolName: entry.event.toolName,
    })),
  };
}

function createCoordinatorToolResultFallback(
  completedToolCalls: ToolCallStreamEvent[],
): StructuredAgentFallbackResponse | null {
  const summaries = getUniqueToolCalls(completedToolCalls)
    .map(createCoordinatorToolSummary)
    .filter((summary): summary is CoordinatorToolSummary => Boolean(summary));

  if (summaries.length === 0) {
    return null;
  }

  return {
    answer: summaries.map((entry) => entry.summary).join("\n\n"),
    confidence: 1,
    keyFacts: summaries.map((entry) => entry.summary),
    toolResults: summaries.map((entry) => ({
      summary: entry.summary,
      toolName: entry.event.toolName,
    })),
  };
}

function getUniqueToolCalls(completedToolCalls: ToolCallStreamEvent[]) {
  const latestByToolAndArgs = new Map<string, ToolCallStreamEvent>();

  for (const event of completedToolCalls) {
    latestByToolAndArgs.set(createToolCallKey(event), event);
  }

  return Array.from(latestByToolAndArgs.values()).sort(
    compareFilesystemToolCalls,
  );
}

function createFilesystemToolSummary(
  event: ToolCallStreamEvent,
): FilesystemToolSummary | null {
  const content = parseToolJsonContent(event.result);
  if (!isRecord(content)) {
    return null;
  }

  if (isToolErrorContent(content)) {
    return {
      errorCode: content.error.code,
      event,
      isError: true,
      summary: summarizeFilesystemToolError(event, content.error),
    };
  }

  let summary: string | null = null;
  if (event.toolName === "list_filesystem_directory") {
    summary = summarizeDirectoryListing(content);
  }

  if (event.toolName === "read_filesystem_file") {
    summary = summarizeReadFile(content);
  }

  if (event.toolName === "search_filesystem_text") {
    summary = summarizeTextSearch(content);
  }

  return summary
    ? {
        event,
        isError: false,
        summary,
      }
    : null;
}

function createMemoryToolSummary(
  event: ToolCallStreamEvent,
): MemoryToolSummary | null {
  const content = parseToolJsonContent(event.result);
  if (!isRecord(content)) {
    return null;
  }

  if (isToolErrorContent(content)) {
    return {
      event,
      isError: true,
      summary: summarizeMemoryToolError(event, content.error),
    };
  }

  let summary: string | null = null;
  if (event.toolName === "save_memory") {
    summary = summarizeSavedMemory(content);
  }

  if (event.toolName === "list_memories") {
    summary = summarizeMemoryList(content);
  }

  if (event.toolName === "delete_memory") {
    summary = summarizeDeletedMemory(content);
  }

  return summary
    ? {
        event,
        isError: false,
        summary,
      }
    : null;
}

function createCoordinatorToolSummary(
  event: ToolCallStreamEvent,
): CoordinatorToolSummary | null {
  const content = parseToolJsonContent(event.result);
  if (!isRecord(content) || typeof content.summary !== "string") {
    return null;
  }

  const isError = content.ok === false;
  return {
    event,
    isError,
    summary: content.summary,
  };
}

function getVisibleFilesystemSummaries(summaries: FilesystemToolSummary[]) {
  const successfulSummaries = summaries.filter((summary) => !summary.isError);
  if (successfulSummaries.length === 0) {
    return summaries;
  }

  return [
    ...successfulSummaries,
    ...summaries.filter(
      (summary) =>
        summary.isError &&
        summary.errorCode !== "not_file" &&
        summary.errorCode !== "not_directory",
    ),
  ];
}

function createToolCallKey(event: ToolCallStreamEvent) {
  return `${event.toolName}:${stringifyToolArgs(event.args)}`;
}

function stringifyToolArgs(args: unknown) {
  if (!isRecord(args)) {
    return JSON.stringify(args) ?? "";
  }

  return JSON.stringify(
    Object.fromEntries(
      Object.entries(args).sort(([leftKey], [rightKey]) =>
        leftKey.localeCompare(rightKey),
      ),
    ),
  );
}

function compareFilesystemToolCalls(
  left: ToolCallStreamEvent,
  right: ToolCallStreamEvent,
) {
  const leftWeight = getFilesystemToolCallWeight(left);
  const rightWeight = getFilesystemToolCallWeight(right);

  if (leftWeight !== rightWeight) {
    return leftWeight - rightWeight;
  }

  return getToolArgsPath(left.args).localeCompare(getToolArgsPath(right.args));
}

function getFilesystemToolCallWeight(event: ToolCallStreamEvent) {
  if (event.toolName === "list_filesystem_directory") {
    return getToolArgsPath(event.args) === "." ? 0 : 1;
  }

  if (event.toolName === "read_filesystem_file") {
    return 2;
  }

  if (event.toolName === "search_filesystem_text") {
    return 3;
  }

  return 4;
}

function summarizeDirectoryListing(content: Record<string, unknown>) {
  const targetPath = formatFilesystemPath(content.path);
  const entries = Array.isArray(content.entries) ? content.entries : [];

  if (entries.length === 0) {
    return `当前沙盒路径 ${targetPath} 下没有文件或目录。`;
  }

  const entryLines = entries
    .map(formatDirectoryEntry)
    .filter((line): line is string => Boolean(line));

  if (entryLines.length === 0) {
    return `当前沙盒路径 ${targetPath} 下没有可展示的文件或目录。`;
  }

  const truncated = content.truncated === true ? "\n结果已截断。" : "";
  return [`当前沙盒路径 ${targetPath} 下有：`, ...entryLines]
    .join("\n")
    .concat(truncated);
}

function summarizeReadFile(content: Record<string, unknown>) {
  const targetPath = formatFilesystemPath(content.path);
  const fileContent =
    typeof content.content === "string" ? content.content.trim() : "";

  if (!fileContent) {
    return `文件 ${targetPath} 是空文本文件。`;
  }

  const displayedContent =
    fileContent.length > FALLBACK_FILE_CONTENT_LIMIT
      ? `${fileContent.slice(0, FALLBACK_FILE_CONTENT_LIMIT)}\n...内容已截断。`
      : fileContent;

  return `文件 ${targetPath} 的内容：\n${displayedContent}`;
}

function summarizeTextSearch(content: Record<string, unknown>) {
  const query = typeof content.query === "string" ? content.query : "";
  const targetPath = formatFilesystemPath(content.path);
  const matches = Array.isArray(content.matches) ? content.matches : [];

  if (matches.length === 0) {
    return `在沙盒路径 ${targetPath} 下没有搜索到 ${JSON.stringify(query)}。`;
  }

  const displayedMatches = matches.slice(0, FALLBACK_SEARCH_MATCH_LIMIT);
  const matchLines = displayedMatches
    .map(formatSearchMatch)
    .filter((line): line is string => Boolean(line));
  const truncated =
    content.truncated === true || matches.length > displayedMatches.length
      ? "\n结果已截断。"
      : "";

  return [`搜索 ${JSON.stringify(query)} 的结果：`, ...matchLines]
    .join("\n")
    .concat(truncated);
}

function summarizeSavedMemory(content: Record<string, unknown>) {
  const memory = isRecord(content.memory) ? content.memory : null;
  const memoryContent =
    memory && typeof memory.content === "string" ? memory.content : "";
  const memoryId =
    memory && typeof memory.memoryId === "string" ? memory.memoryId : "";

  if (!memoryContent) {
    return "记忆已保存。";
  }

  return memoryId
    ? `已保存记忆 ${memoryId}：${memoryContent}`
    : `已保存记忆：${memoryContent}`;
}

function summarizeMemoryList(content: Record<string, unknown>) {
  const memories = Array.isArray(content.memories) ? content.memories : [];

  if (memories.length === 0) {
    return "当前没有保存的长期记忆。";
  }

  const memoryLines = memories
    .map(formatMemoryEntry)
    .filter((line): line is string => Boolean(line));

  if (memoryLines.length === 0) {
    return "当前没有可展示的长期记忆。";
  }

  return ["已保存的长期记忆：", ...memoryLines].join("\n");
}

function summarizeDeletedMemory(content: Record<string, unknown>) {
  const memoryId =
    typeof content.memoryId === "string" && content.memoryId.trim()
      ? content.memoryId
      : "";

  return memoryId ? `已删除记忆 ${memoryId}。` : "已删除记忆。";
}

function formatDirectoryEntry(entry: unknown) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const data = entry as Record<string, unknown>;
  const entryPath = typeof data.path === "string" ? data.path : data.name;
  if (typeof entryPath !== "string" || !entryPath.trim()) {
    return null;
  }

  const type = typeof data.type === "string" ? data.type : "unknown";
  const size =
    typeof data.sizeBytes === "number" ? `，${data.sizeBytes} bytes` : "";

  return `- ${entryPath}（${type}${size}）`;
}

function formatSearchMatch(match: unknown) {
  if (!match || typeof match !== "object") {
    return null;
  }

  const data = match as Record<string, unknown>;
  const matchPath = typeof data.path === "string" ? data.path : "";
  const lineNumber =
    typeof data.lineNumber === "number" ? data.lineNumber : undefined;
  const line = typeof data.line === "string" ? data.line : "";

  if (!matchPath || !line) {
    return null;
  }

  return `- ${matchPath}:${lineNumber ?? "?"} ${line}`;
}

function formatMemoryEntry(memory: unknown) {
  if (!isRecord(memory)) {
    return null;
  }

  const memoryId = typeof memory.memoryId === "string" ? memory.memoryId : "";
  const content = typeof memory.content === "string" ? memory.content : "";
  const category =
    typeof memory.category === "string" && memory.category.trim()
      ? memory.category
      : "general";

  if (!content) {
    return null;
  }

  return memoryId
    ? `- ${content}（${category}，id: ${memoryId}）`
    : `- ${content}（${category}）`;
}

function summarizeFilesystemToolError(
  event: ToolCallStreamEvent,
  error: { code: string; message: string },
) {
  const targetPath = formatFilesystemPath(getToolArgsPath(event.args));

  if (event.toolName === "read_filesystem_file") {
    if (error.code === "not_file") {
      return `路径 ${targetPath} 不是普通文件，不能读取内容；如果它是目录，请使用 list_filesystem_directory 查看目录内容。`;
    }

    if (error.code === "file_not_found") {
      return `文件 ${targetPath} 不存在。`;
    }
  }

  if (event.toolName === "list_filesystem_directory") {
    if (error.code === "not_directory") {
      return `路径 ${targetPath} 不是目录，不能列出目录内容。`;
    }
  }

  return `工具 ${event.toolName} 返回错误：${error.code}，${error.message}`;
}

function summarizeMemoryToolError(
  event: ToolCallStreamEvent,
  error: { code: string; message: string },
) {
  return `工具 ${event.toolName} 返回错误：${error.code}，${error.message}`;
}

function getToolArgsPath(args: unknown) {
  if (!isRecord(args)) {
    return ".";
  }

  const inputPath = args.path;
  return typeof inputPath === "string" && inputPath.trim() ? inputPath : ".";
}

function parseToolJsonContent(result: unknown) {
  if (!result || typeof result !== "object" || !("content" in result)) {
    return null;
  }

  const content = (result as { content?: unknown }).content;
  if (typeof content !== "string") {
    return null;
  }

  try {
    return JSON.parse(content) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isToolErrorContent(
  content: Record<string, unknown>,
): content is { error: { code: string; message: string }; ok: false } {
  if (content.ok !== false || !content.error || typeof content.error !== "object") {
    return false;
  }

  const error = content.error as Record<string, unknown>;
  return typeof error.code === "string" && typeof error.message === "string";
}

function formatFilesystemPath(value: unknown) {
  const pathValue = typeof value === "string" && value.trim() ? value : ".";
  return `\`${pathValue}\``;
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

function isToolApprovalRequiredError(
  error: unknown,
): error is ToolApprovalRequiredError {
  return error instanceof ToolApprovalRequiredError;
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
