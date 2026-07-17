import {
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
import { DEFAULT_MODEL_TIMEOUT } from "./chat-model";
import { createHarnessedAgent } from "../harness";
import {
  offloadToolResultIfNeeded,
  type ContextOffloadPolicy,
} from "../harness/context";
import { createRequestLogger, logger, toLogError } from "@/lib/server/logger";
import { createPendingAction } from "@/lib/server/pending-action-store";
import { previewSaveMemory } from "@/lib/server/memory-store";
import { getPostgresPool, hasDatabaseUrl } from "@/lib/server/postgres";
import {
  loadThreadAgentMessages,
  mergeAgentMessages,
} from "@/lib/server/thread-store";
import type { ThreadScope } from "@/lib/server/thread-store/persistence";
import {
  previewFilesystemDelete,
  previewFilesystemEdit,
  previewFilesystemWrite,
} from "@/lib/agent/services/filesystem-service";
import {
  getThreadTodoState,
  type TodoState,
} from "@/lib/agent/harness/planning";
import {
  withHarnessMemory,
  type MemoryManifest,
} from "@/lib/agent/harness/memory";
import {
  getReadonlySubagentDefinition,
  type RunSubagentTaskInput,
  type SubagentTaskResult,
  type SubagentToolResult,
} from "@/lib/agent/harness/subagents";
import type {
  AgentDefinition,
  AgentMessage,
  CreateConfiguredAgentOptions,
} from "./agent-definition";

type StreamConfiguredAgentEventsOptions = CreateConfiguredAgentOptions & {
  contextPolicy?: ContextOffloadPolicy;
  definition: AgentDefinition;
  memoryContext?: string;
  memoryManifest?: MemoryManifest;
  messages: AgentMessage[];
  onStreamEvent?: (event: ChatStreamEvent) => void;
  planningEnabled?: boolean;
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
type ApprovalPreparation =
  | {
      preview?: ApprovalPendingPayload["preview"];
      requiresApproval: true;
    }
  | {
      requiresApproval: false;
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

async function createConfiguredAgent(
  definition: AgentDefinition,
  options: CreateConfiguredAgentOptions & {
    memoryContext?: string;
    memoryManifest?: MemoryManifest;
    onStreamEvent?: (event: ChatStreamEvent) => void;
    planningEnabled?: boolean;
    runLogger?: Logger;
    runConfig?: RunnableConfig;
    signal?: AbortSignal;
    threadId?: string;
    threadScope?: ThreadScope;
    todoState?: TodoState | null;
    contextPolicy?: ContextOffloadPolicy;
  },
) {
  return createHarnessedAgent({
    ...options,
    definition,
    createMiddleware: createAgentMiddleware,
    getCheckpointer: getAgentCheckpointer,
    getCheckpointerType,
    runSubagent: runSubagentTask,
  });
}

export async function* streamConfiguredAgentEvents({
  contextPolicy,
  definition,
  memoryContext,
  memoryManifest,
  messages,
  onStreamEvent,
  planningEnabled = true,
  runConfig,
  signal,
  threadId,
  threadScope,
  ...modelOptions
}: StreamConfiguredAgentEventsOptions) {
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
  const todoState =
    threadId && threadScope
      ? await getThreadTodoState(threadScope, threadId)
      : null;
  const effectiveMemoryManifest = withHarnessMemory(memoryManifest, {
    threadId,
    todoState,
  });
  const agent = await createConfiguredAgent(definition, {
    ...modelOptions,
    contextPolicy,
    memoryContext,
    memoryManifest: effectiveMemoryManifest,
    onStreamEvent: (event) => {
      if (event.type === "tool_call" && event.status === "complete") {
        completedToolCallCount += 1;
        completedToolCalls.push(event);
      }

      onStreamEvent?.(event);
      queue.push(event);
    },
    planningEnabled,
    runConfig,
    runLogger,
    signal,
    threadId,
    threadScope,
    todoState,
  });
  const agentCheckpointer = await getAgentCheckpointer();
  const agentThreadId = threadId
    ? createAgentThreadId(definition.id, threadId, threadScope)
    : undefined;
  const legacyAgentThreadId = threadId
    ? createLegacyAgentThreadId(definition.id, threadId, threadScope)
    : undefined;
  const primaryCheckpoint = agentThreadId
    ? await getCheckpointTuple(agentCheckpointer, agentThreadId)
    : undefined;
  const legacyCheckpoint =
    agentThreadId &&
    legacyAgentThreadId &&
    agentThreadId !== legacyAgentThreadId &&
    !primaryCheckpoint
      ? await getCheckpointTuple(agentCheckpointer, legacyAgentThreadId)
      : undefined;
  const invocationMessages =
    agentThreadId && threadId && threadScope
      ? await getMessagesForCheckpointedRun({
          agentThreadId,
          checkpoint: primaryCheckpoint,
          legacyCheckpoint,
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
  const pushAgentRetryEvent = ({
    attempt,
    error,
    maxAttempts,
  }: {
    attempt: number;
    error: Error;
    maxAttempts: number;
  }) => {
    const lastToolCall = completedToolCalls.at(-1);
    const event: ChatStreamEvent = {
      attempt,
      completedToolCallCount,
      ...(lastToolCall
        ? {
            lastToolCall: {
              toolCallId: lastToolCall.toolCallId,
              toolName: lastToolCall.toolName,
            },
          }
        : {}),
      maxAttempts,
      reason: formatUnknownError(error),
      recovery: "checkpoint",
      type: "agent_retry",
    };

    onStreamEvent?.(event);
    queue.push(event);
  };

  runLogger.info(
    {
      agentThreadId,
      checkpointer: getCheckpointerType(agentCheckpointer),
      hasMemoryContext: Boolean(memoryContext),
      memoryEntryCounts: effectiveMemoryManifest
        ? {
            harness: 1,
            project: effectiveMemoryManifest.project.length,
            user: effectiveMemoryManifest.user.length,
          }
        : undefined,
      legacyCheckpointFallback: Boolean(legacyCheckpoint),
      hasTodoState: Boolean(todoState?.todos.length),
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
      const normalizedError = toError(error);
      if (
        agentThreadId &&
        completedToolCallCount > 0 &&
        !signal.aborted &&
        shouldRetryAgentError(normalizedError)
      ) {
        runLogger.warn(
          {
            completedToolCallCount,
            err: toLogError(normalizedError),
          },
          "agent invoke failed after tool call; retrying from checkpoint",
        );
        pushAgentRetryEvent({
          attempt: 1,
          error: normalizedError,
          maxAttempts: 1,
        });
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

async function runSubagentTask({
  agent,
  apiKey,
  baseURL,
  childThreadId,
  context,
  contextPolicy,
  modelName,
  memoryManifest,
  parentAgentId,
  parentThreadId,
  runConfig,
  runLogger,
  signal,
  subtaskId,
  task,
  threadScope,
}: RunSubagentTaskInput): Promise<SubagentTaskResult> {
  const startedAt = Date.now();
  const definition = getReadonlySubagentDefinition(agent);
  if (!definition) {
    return {
      agent,
      childThreadId,
      error: {
        code: "unsupported_subagent",
        message: `Unsupported subagent: ${agent}.`,
      },
      ok: false,
      subtaskId,
      summary: `子任务执行失败：不支持的 subagent ${agent}。`,
    };
  }

  const subagentLogger = runLogger?.child({
    childThreadId,
    component: "subagent-runner",
    parentAgentId,
    parentThreadId,
    subagentId: agent,
    subtaskId,
  });
  const childRunConfig = createSubagentRunConfig(runConfig, {
    agent,
    childThreadId,
    parentAgentId,
    parentThreadId,
    subtaskId,
  });
  const childSignal = signal ?? new AbortController().signal;
  const toolResults: SubagentToolResult[] = [];
  let structuredResponse: unknown;
  let text = "";

  subagentLogger?.info("subagent task started");

  try {
    for await (const event of streamConfiguredAgentEvents({
      apiKey,
      baseURL,
      contextPolicy,
      definition,
      memoryManifest,
      messages: [
        {
          role: "user",
          content: buildSubagentTaskMessage({
            agent,
            context,
            task,
          }),
        },
      ],
      modelName,
      planningEnabled: false,
      runConfig: childRunConfig,
      signal: childSignal,
      threadId: childThreadId,
      threadScope,
    })) {
      if (event.type === "text_delta") {
        text += event.text;
      }

      if (event.type === "structured_response") {
        structuredResponse = event.response;
      }

      if (event.type === "tool_call" && event.status === "complete") {
        const result = createSubagentToolResult(agent, event);
        if (result) {
          toolResults.push(result);
        }
      }
    }

    const structuredToolResults = getStructuredToolResults(structuredResponse);
    const visibleToolResults =
      structuredToolResults.length > 0 ? structuredToolResults : toolResults;
    const summary =
      getStructuredAnswer(structuredResponse) ||
      text.trim() ||
      visibleToolResults.map((result) => result.summary).join("\n\n") ||
      "子任务已完成，但没有返回可展示摘要。";

    subagentLogger?.info(
      {
        durationMs: Date.now() - startedAt,
        status: "complete",
        toolResultCount: visibleToolResults.length,
      },
      "subagent task completed",
    );

    return {
      agent,
      childThreadId,
      ok: true,
      subtaskId,
      summary,
      toolResults: visibleToolResults,
    };
  } catch (error) {
    const message = formatUnknownError(error);
    subagentLogger?.error(
      {
        durationMs: Date.now() - startedAt,
        err: toLogError(error),
        status: "error",
      },
      "subagent task failed",
    );

    return {
      agent,
      childThreadId,
      error: {
        code: "subagent_failed",
        message,
      },
      ok: false,
      subtaskId,
      summary: `子任务执行失败：${message}`,
      ...(toolResults.length > 0 ? { toolResults } : {}),
    };
  }
}

function createSubagentRunConfig(
  parentRunConfig: RunnableConfig | undefined,
  {
    agent,
    childThreadId,
    parentAgentId,
    parentThreadId,
    subtaskId,
  }: {
    agent: RunSubagentTaskInput["agent"];
    childThreadId: string;
    parentAgentId: string;
    parentThreadId: string;
    subtaskId: string;
  },
): RunnableConfig {
  const tags = Array.isArray(parentRunConfig?.tags) ? parentRunConfig.tags : [];
  const metadata = isRecord(parentRunConfig?.metadata)
    ? parentRunConfig.metadata
    : {};

  return {
    ...parentRunConfig,
    runName: `subagent:${agent}`,
    tags: [...tags, `subagent:${agent}`],
    metadata: {
      ...metadata,
      child_thread_id: childThreadId,
      parent_agent_id: parentAgentId,
      parent_thread_id: parentThreadId,
      subagent: agent,
      subtask_id: subtaskId,
    },
  };
}

function buildSubagentTaskMessage({
  agent,
  context,
  task,
}: {
  agent: RunSubagentTaskInput["agent"];
  context?: string;
  task: string;
}) {
  const contextSection = context?.trim()
    ? `\n\n## 补充上下文\n${context.trim()}`
    : "";

  return `请作为 ${agent} subagent 完成下面这个隔离子任务。

## 子任务
${task.trim()}${contextSection}

## 输出要求
- 只输出这个子任务的 final report。
- 用中文回答。
- 包含结论和关键依据。
- 不要提及或展开父 agent 的完整上下文。`;
}

function createSubagentToolResult(
  agent: RunSubagentTaskInput["agent"],
  event: ToolCallStreamEvent,
): SubagentToolResult | null {
  if (agent === "filesystem") {
    return toSubagentToolResult(createFilesystemToolSummary(event));
  }

  if (agent === "memory") {
    return toSubagentToolResult(createMemoryToolSummary(event));
  }

  return createGenericSubagentToolResult(event);
}

function toSubagentToolResult(
  summary:
    | FilesystemToolSummary
    | MemoryToolSummary
    | CoordinatorToolSummary
    | null,
): SubagentToolResult | null {
  return summary
    ? {
        summary: summary.summary,
        toolName: summary.event.toolName,
      }
    : null;
}

function createGenericSubagentToolResult(
  event: ToolCallStreamEvent,
): SubagentToolResult | null {
  const content = parseToolJsonContent(event.result);
  if (isRecord(content) && typeof content.summary === "string") {
    return {
      summary: content.summary,
      toolName: event.toolName,
    };
  }

  const result = event.result;
  if (isRecord(result) && typeof result.content === "string") {
    return {
      summary: result.content,
      toolName: event.toolName,
    };
  }

  return null;
}

function getStructuredToolResults(
  structuredResponse: unknown,
): SubagentToolResult[] {
  if (!isRecord(structuredResponse) || !Array.isArray(structuredResponse.toolResults)) {
    return [];
  }

  return structuredResponse.toolResults
    .map((result) => {
      if (!isRecord(result)) {
        return null;
      }

      const summary = result.summary;
      const toolName = result.toolName;
      return typeof summary === "string" && typeof toolName === "string"
        ? {
            summary,
            toolName,
          }
        : null;
    })
    .filter((result): result is SubagentToolResult => Boolean(result));
}

function createToolCallStreamingMiddleware(
  onStreamEvent: (event: ChatStreamEvent) => void,
  runLogger?: Logger,
  approvalContext?: {
    agentId: AgentDefinition["id"];
    contextPolicy?: ContextOffloadPolicy;
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
        if (pendingAction) {
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
        const offloadedResult = await offloadToolResultIfNeeded({
          args,
          policy: approvalContext?.contextPolicy,
          result,
          threadId: approvalContext?.threadId,
          threadScope: approvalContext?.threadScope,
          toolCallId,
          toolName,
        });
        const visibleResult = offloadedResult.offloaded
          ? offloadedResult.result
          : result;

        if (offloadedResult.offloaded) {
          runLogger?.info(
            {
              artifactPath: offloadedResult.artifactPath,
              originalSizeBytes: offloadedResult.originalSizeBytes,
              summary: offloadedResult.summary,
              toolCallId,
              toolName,
            },
            "agent tool result offloaded",
          );
        } else if (offloadedResult.reason === "write_failed") {
          runLogger?.warn(
            {
              err: offloadedResult.writeError,
              toolCallId,
              toolName,
            },
            "agent tool result offload failed",
          );
        }

        runLogger?.debug(
          {
            result: summarizeLogValue(visibleResult),
            toolCallId,
            toolName,
          },
          "agent tool call completed",
        );
        onStreamEvent({
          type: "tool_call",
          args,
          result: normalizeToolResult(visibleResult),
          status: "complete",
          toolCallId,
          toolName,
        });
        return visibleResult;
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

function createAgentMiddleware({
  agentId,
  contextPolicy,
  onStreamEvent,
  runLogger,
  threadId,
  threadScope,
}: {
  agentId: AgentDefinition["id"];
  contextPolicy?: ContextOffloadPolicy;
  onStreamEvent?: (event: ChatStreamEvent) => void;
  runLogger?: Logger;
  threadId?: string;
  threadScope?: ThreadScope;
}): readonly AnyAgentMiddleware[] {
  const retryMiddleware = [
    toolRetryMiddleware(AGENT_RETRY_OPTIONS),
    modelRetryMiddleware(AGENT_RETRY_OPTIONS),
  ] satisfies readonly AnyAgentMiddleware[];

  if (!onStreamEvent) {
    return retryMiddleware;
  }

  return [
    createToolCallStreamingMiddleware(onStreamEvent, runLogger, {
      agentId,
      contextPolicy,
      threadId,
      threadScope,
    }),
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

  const approvalPreparation = await prepareApprovalAction({
    args,
    threadId: approvalContext.threadId,
    threadScope: approvalContext.threadScope,
    toolName,
  });
  if (!approvalPreparation.requiresApproval) {
    return null;
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
    preview: approvalPreparation.preview,
    toolCallId,
    toolName,
  } satisfies ApprovalPendingPayload;
}

function createToolApprovalPayload(action: ApprovalPendingPayload) {
  const actionLabel = getApprovalActionLabel(action.toolName);

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
        description: getApprovalRejectDescription(action.toolName),
      },
    ],
    ...(action.preview ? { preview: action.preview } : {}),
  };
}

async function prepareApprovalAction({
  args,
  threadId,
  threadScope,
  toolName,
}: {
  args: unknown;
  threadId: string;
  threadScope: ThreadScope;
  toolName: ApprovalGatedToolName;
}): Promise<ApprovalPreparation> {
  if (isFilesystemMutationToolName(toolName)) {
    const preview = await createFilesystemApprovalPreview({
      args,
      threadId,
      threadScope,
      toolName,
    });

    return preview
      ? {
          preview,
          requiresApproval: true,
        }
      : {
          requiresApproval: false,
        };
  }

  return {
    preview: await createMemoryApprovalPreview({
      args,
      threadScope,
      toolName,
    }),
    requiresApproval: true,
  };
}

async function createMemoryApprovalPreview({
  args,
  threadScope,
  toolName,
}: {
  args: unknown;
  threadScope: ThreadScope;
  toolName: ApprovalGatedToolName;
}) {
  if (toolName !== "save_memory" || !isRecord(args)) {
    return undefined;
  }

  const content = typeof args.content === "string" ? args.content.trim() : "";
  if (!content) {
    return undefined;
  }

  const category =
    typeof args.category === "string" && args.category.trim()
      ? args.category
      : "general";

  return (await previewSaveMemory(threadScope, {
    category,
    content,
  })) ?? undefined;
}

async function createFilesystemApprovalPreview({
  args,
  threadId,
  threadScope,
  toolName,
}: {
  args: unknown;
  threadId: string;
  threadScope: ThreadScope;
  toolName: ApprovalGatedToolName;
}) {
  if (!isRecord(args)) {
    return undefined;
  }

  const inputPath = typeof args.path === "string" ? args.path : "";
  if (!inputPath) {
    return undefined;
  }

  if (toolName === "write_file") {
    if (typeof args.content !== "string") {
      return undefined;
    }

    const preview = await previewFilesystemWrite(
      {
        threadId,
        threadScope,
      },
      {
        content: args.content,
        path: inputPath,
      },
    );
    return preview.ok ? preview.preview : undefined;
  }

  if (toolName === "edit_file") {
    if (typeof args.oldText !== "string" || typeof args.newText !== "string") {
      return undefined;
    }

    const preview = await previewFilesystemEdit(
      {
        threadId,
        threadScope,
      },
      {
        newText: args.newText,
        oldText: args.oldText,
        path: inputPath,
        replaceAll: args.replaceAll === true,
      },
    );
    return preview.ok ? preview.preview : undefined;
  }

  if (toolName === "delete_file") {
    const preview = await previewFilesystemDelete(
      {
        threadId,
        threadScope,
      },
      {
        path: inputPath,
      },
    );
    return preview.ok ? preview.preview : undefined;
  }

  return undefined;
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

  if (toolName === "write_file") {
    return `需要你确认后才会写入文件${formatApprovalPathSuffix(args)}。`;
  }

  if (toolName === "edit_file") {
    return `需要你确认后才会编辑文件${formatApprovalPathSuffix(args)}。`;
  }

  if (toolName === "delete_file") {
    return `需要你确认后才会删除文件${formatApprovalPathSuffix(args)}。`;
  }

  const memoryId =
    isRecord(args) && typeof args.memoryId === "string"
      ? ` ${args.memoryId}`
      : "";
  return `需要你确认后才会删除长期记忆${memoryId}。`;
}

function isFilesystemMutationToolName(
  toolName: ApprovalGatedToolName,
): toolName is Extract<
  ApprovalGatedToolName,
  "delete_file" | "edit_file" | "write_file"
> {
  return (
    toolName === "write_file" ||
    toolName === "edit_file" ||
    toolName === "delete_file"
  );
}

function getApprovalActionLabel(toolName: ApprovalGatedToolName) {
  if (toolName === "save_memory") {
    return "保存记忆";
  }

  if (toolName === "delete_memory") {
    return "删除记忆";
  }

  if (toolName === "write_file") {
    return "写入文件";
  }

  if (toolName === "edit_file") {
    return "编辑文件";
  }

  return "删除文件";
}

function getApprovalRejectDescription(toolName: ApprovalGatedToolName) {
  return toolName === "save_memory" || toolName === "delete_memory"
    ? "取消本次工具调用，不修改长期记忆。"
    : "取消本次工具调用，不修改文件。";
}

function formatApprovalPathSuffix(args: unknown) {
  return isRecord(args) && typeof args.path === "string" && args.path.trim()
    ? ` \`${args.path.trim()}\``
    : "";
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
    ? `${agentId}:${scope.tenantHashId}:${scope.userHashId}:${scope.workspaceId}:${threadId}`
    : `${agentId}:${threadId}`;
}

function createLegacyAgentThreadId(
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
  checkpoint,
  legacyCheckpoint,
  messages,
  scope,
  threadId,
}: {
  agentThreadId: string;
  checkpoint?: unknown;
  legacyCheckpoint?: unknown;
  messages: AgentMessage[];
  scope: ThreadScope;
  threadId: string;
}) {
  const checkpointExists = initializedAgentThreads.has(agentThreadId) || Boolean(checkpoint);

  if (!checkpointExists) {
    const legacyMessages = extractCheckpointMessages(legacyCheckpoint);
    if (legacyMessages.length > 0) {
      return mergeAgentMessages(legacyMessages, messages);
    }

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

async function getCheckpointTuple(
  checkpointer: AgentCheckpointer,
  threadId: string,
) {
  if (initializedAgentThreads.has(threadId)) {
    return { initialized: true };
  }

  return checkpointer.getTuple({
    configurable: {
      thread_id: threadId,
    },
  });
}

function extractCheckpointMessages(value: unknown): AgentMessage[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const checkpoint = value as {
    checkpoint?: {
      channel_values?: Record<string, unknown>;
    };
  };
  const channelValues = checkpoint.checkpoint?.channel_values;
  const messages = channelValues?.messages;
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages.flatMap((message) => {
    if (!message || typeof message !== "object") {
      return [];
    }

    const candidate = message as {
      content?: unknown;
      role?: unknown;
      type?: unknown;
    };
    const role = candidate.role ?? candidate.type;
    if (role !== "system" && role !== "user" && role !== "assistant" && role !== "human" && role !== "ai") {
      return [];
    }

    return [{
      content: normalizeMessageContent(candidate.content),
      role: role === "human" ? "user" : role === "ai" ? "assistant" : role,
    } satisfies AgentMessage];
  });
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

  if (isContextOffloadReferenceContent(content)) {
    return {
      event,
      isError: false,
      summary: summarizeOffloadedToolResult(content),
    };
  }

  let summary: string | null = null;
  if (event.toolName === "list_filesystem_directory") {
    summary = summarizeDirectoryListing(content);
  }

  if (event.toolName === "glob_files") {
    summary = summarizeGlobFiles(content);
  }

  if (event.toolName === "read_filesystem_file") {
    summary = summarizeReadFile(content);
  }

  if (event.toolName === "search_filesystem_text") {
    summary = summarizeTextSearch(content);
  }

  if (event.toolName === "write_file") {
    summary = summarizeWrittenFile(content);
  }

  if (event.toolName === "edit_file") {
    summary = summarizeEditedFile(content);
  }

  if (event.toolName === "delete_file") {
    summary = summarizeDeletedFile(content);
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

  if (isContextOffloadReferenceContent(content)) {
    return {
      event,
      isError: false,
      summary: summarizeOffloadedToolResult(content),
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

  if (isContextOffloadReferenceContent(content)) {
    return {
      event,
      isError: false,
      summary: summarizeOffloadedToolResult(content),
    };
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
    return 3;
  }

  if (event.toolName === "search_filesystem_text") {
    return 4;
  }

  if (event.toolName === "glob_files") {
    return 2;
  }

  if (
    event.toolName === "write_file" ||
    event.toolName === "edit_file" ||
    event.toolName === "delete_file"
  ) {
    return 5;
  }

  return 6;
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

function summarizeGlobFiles(content: Record<string, unknown>) {
  const pattern = typeof content.pattern === "string" ? content.pattern : "";
  const targetPath = formatFilesystemPath(content.path);
  const matches = Array.isArray(content.matches) ? content.matches : [];

  if (matches.length === 0) {
    return `在沙盒路径 ${targetPath} 下没有找到匹配 ${JSON.stringify(pattern)} 的文件。`;
  }

  const matchLines = matches
    .slice(0, FALLBACK_SEARCH_MATCH_LIMIT)
    .map(formatFilesystemMatch)
    .filter((line): line is string => Boolean(line));
  const truncated =
    content.truncated === true || matches.length > matchLines.length
      ? "\n结果已截断。"
      : "";

  return [`匹配 ${JSON.stringify(pattern)} 的文件：`, ...matchLines]
    .join("\n")
    .concat(truncated);
}

function summarizeWrittenFile(content: Record<string, unknown>) {
  const targetPath = formatFilesystemPath(content.path);
  const operation = content.operation === "create" ? "创建" : "覆盖";
  const size =
    typeof content.sizeBytes === "number" ? `，大小 ${content.sizeBytes} bytes` : "";

  return `已${operation}文件 ${targetPath}${size}。`;
}

function summarizeEditedFile(content: Record<string, unknown>) {
  const targetPath = formatFilesystemPath(content.path);
  const replacements =
    typeof content.replacements === "number" ? content.replacements : 0;

  return replacements > 0
    ? `已编辑文件 ${targetPath}，替换 ${replacements} 处文本。`
    : `已编辑文件 ${targetPath}。`;
}

function summarizeDeletedFile(content: Record<string, unknown>) {
  const targetPath = formatFilesystemPath(content.path);
  return `已删除文件 ${targetPath}。`;
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

function summarizeOffloadedToolResult(content: {
  artifactPath: string;
  originalSizeBytes: number;
  summary: string;
}) {
  return `${content.summary}\n原始工具结果已写入 \`${content.artifactPath}\`，大小 ${content.originalSizeBytes} bytes。`;
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

function formatFilesystemMatch(match: unknown) {
  if (!isRecord(match)) {
    return null;
  }

  const matchPath = typeof match.path === "string" ? match.path : "";
  if (!matchPath) {
    return null;
  }

  const size =
    typeof match.sizeBytes === "number" ? `，${match.sizeBytes} bytes` : "";
  return `- ${matchPath}${size}`;
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

function isContextOffloadReferenceContent(
  content: Record<string, unknown>,
): content is {
  artifactPath: string;
  offloaded: true;
  originalSizeBytes: number;
  summary: string;
} {
  return (
    content.offloaded === true &&
    typeof content.artifactPath === "string" &&
    typeof content.originalSizeBytes === "number" &&
    typeof content.summary === "string"
  );
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
