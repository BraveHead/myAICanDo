"use client";

import {
  AssistantRuntimeProvider,
  useLocalRuntime,
  type ChatModelAdapter,
  type ThreadAssistantMessagePart,
  type ThreadMessage,
  type ToolCallMessagePart,
} from "@assistant-ui/react";
import { type PropsWithChildren, useMemo, useRef } from "react";
import {
  isSupportedAgent,
  type SupportedAgent,
} from "@/lib/agent/shared/agent-ids";
import {
  APPROVAL_GATED_TOOL_NAMES,
  isApprovalGatedToolName,
  type ApprovalExecutionResponse,
} from "@/lib/approval-actions";
import type { ChatStreamEvent } from "@/lib/chat-stream";
import { isChatStreamEvent } from "@/lib/chat-stream";
import {
  applyChatStreamProjection,
  createChatStreamProjection,
  dedupeFilesystemChanges,
} from "@/lib/chat-stream-projection";
import {
  createApprovalRequestBody,
  type ClientApprovalDecision,
} from "@/lib/approval-decision";
import { loadActiveThreadId } from "@/lib/thread-storage";

type ApiMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export function ChatRuntimeProvider({
  children,
  tenantHashId,
  workspaceId,
}: PropsWithChildren<{ tenantHashId: string; workspaceId: string }>) {
  const emittedFilesystemChangeIdsRef = useRef(new Set<string>());
  const emittedCommandResultIdsRef = useRef(new Set<string>());
  const adapter = useMemo<ChatModelAdapter>(
    () => ({
      async *run({
        messages,
        abortSignal,
        unstable_getMessage,
        unstable_threadId,
        runConfig,
      }) {
        const threadId =
          loadActiveThreadId(tenantHashId, workspaceId) ?? unstable_threadId;
        const approvalDecisions = getApprovalDecisions(unstable_getMessage());
        if (approvalDecisions.length > 0) {
          if (!threadId) {
            throw new Error("缺少 threadId，无法执行人工确认。");
          }

          yield* runApprovalExecutions({
            abortSignal,
            approvalDecisions,
            tenantHashId,
            threadId,
            workspaceId,
            emittedFilesystemChangeIds:
              emittedFilesystemChangeIdsRef.current,
            emittedCommandResultIds: emittedCommandResultIdsRef.current,
          });
          return;
        }

        const apiMessages = messages.map(toApiMessage).filter(isApiMessage);
        const latestMessage = getLatestMessage(apiMessages);

        if (!latestMessage) {
          throw new Error("没有可发送的用户消息。");
        }

        const response = await fetch(
          `/api/tenants/${encodeURIComponent(tenantHashId)}/chat`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              message: latestMessage,
              model:
                typeof runConfig.custom?.model === "string"
                  ? runConfig.custom.model
                  : undefined,
              agent: getSupportedAgent(runConfig.custom?.agent),
              threadId,
              workspaceId,
            }),
            signal: abortSignal,
          },
        );
        yield* streamChatResponse(response);
      },
    }),
    [tenantHashId, workspaceId],
  );
  const runtime = useLocalRuntime(adapter, {
    unstable_humanToolNames: [...APPROVAL_GATED_TOOL_NAMES],
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
}

function getApprovalDecisions(message: ThreadMessage): ClientApprovalDecision[] {
  if (message.role !== "assistant") {
    return [];
  }

  const decisions: ClientApprovalDecision[] = [];
  for (const part of message.content) {
    if (
      part.type !== "tool-call" ||
      !part.approval ||
      part.approval.approved === undefined ||
      part.approval.resolution !== undefined ||
      !isApprovalGatedToolName(part.toolName)
    ) {
      continue;
    }

    decisions.push({
      approvalId: part.approval.id,
      approved: part.approval.approved,
      optionId: part.approval.optionId,
      reason: part.approval.reason,
    });
  }

  return decisions;
}

async function* runApprovalExecutions({
  abortSignal,
  approvalDecisions,
  emittedFilesystemChangeIds,
  emittedCommandResultIds,
  tenantHashId,
  threadId,
  workspaceId,
}: {
  abortSignal: AbortSignal;
  approvalDecisions: ClientApprovalDecision[];
  emittedFilesystemChangeIds: Set<string>;
  emittedCommandResultIds: Set<string>;
  tenantHashId: string;
  threadId: string;
  workspaceId: string;
}) {
  const responses: ApprovalExecutionResponse[] = [];
  for (const approvalDecision of approvalDecisions) {
    responses.push(
      await executeApprovalDecision({
        abortSignal,
        approvalDecision,
        tenantHashId,
        threadId,
        workspaceId,
      }),
    );
  }

  const filesystemChangeParts = dedupeFilesystemChanges(
    responses.map((response) => response.filesystemChange),
    emittedFilesystemChangeIds,
  ).map((change) => ({
    type: "data" as const,
    name: "filesystem_change" as const,
    data: change,
  }));
  const commandResultParts = responses
    .map((response) =>
      response.commandResult
        ? { ...response.commandResult, approvalId: response.approvalId }
        : undefined,
    )
    .filter((result): result is NonNullable<typeof result> => {
      if (!result || emittedCommandResultIds.has(result.executionId)) {
        return false;
      }
      emittedCommandResultIds.add(result.executionId);
      return true;
    })
    .map((result) => ({
      type: "data" as const,
      name: "command_result" as const,
      data: result,
    }));

  yield {
    content: [
      { type: "text", text: mergeApprovalFinalText(responses) },
      ...filesystemChangeParts,
      ...commandResultParts,
      {
        type: "data",
        name: "structured_response",
        data: mergeApprovalStructuredResponse(responses),
      },
    ] satisfies ThreadAssistantMessagePart[],
    status: {
      type: "complete" as const,
      reason: "unknown" as const,
    },
  };

  for (const response of responses) {
    if (!response.followUpMessage) {
      continue;
    }

    const followUpResponse = await fetch(
      `/api/tenants/${encodeURIComponent(tenantHashId)}/chat`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: {
            content: response.followUpMessage,
            role: "user",
          },
          threadId,
          workspaceId,
        }),
        signal: abortSignal,
      },
    );

    yield* streamChatResponse(followUpResponse);
  }
}

async function executeApprovalDecision({
  abortSignal,
  approvalDecision,
  tenantHashId,
  threadId,
  workspaceId,
}: {
  abortSignal: AbortSignal;
  approvalDecision: ClientApprovalDecision;
  tenantHashId: string;
  threadId: string;
  workspaceId: string;
}) {
  const response = await fetch(
    `/api/tenants/${encodeURIComponent(tenantHashId)}/chat/approvals`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        createApprovalRequestBody({ approvalDecision, threadId, workspaceId }),
      ),
      signal: abortSignal,
    },
  );

  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  return (await response.json()) as ApprovalExecutionResponse;
}

function mergeApprovalFinalText(responses: ApprovalExecutionResponse[]) {
  return responses
    .map((response) => response.finalText.trim())
    .filter(Boolean)
    .join("\n");
}

function mergeApprovalStructuredResponse(responses: ApprovalExecutionResponse[]) {
  if (responses.length === 1) {
    return responses[0].structuredResponse;
  }

  const finalText = mergeApprovalFinalText(responses);
  return {
    answer: finalText,
    confidence: Math.min(
      ...responses.map((response) => response.structuredResponse.confidence),
    ),
    keyFacts: responses.flatMap(
      (response) => response.structuredResponse.keyFacts,
    ),
    toolResults: responses.flatMap(
      (response) => response.structuredResponse.toolResults,
    ),
  } satisfies ApprovalExecutionResponse["structuredResponse"];
}

function getSupportedAgent(agent: unknown): SupportedAgent | undefined {
  if (isSupportedAgent(agent)) {
    return agent;
  }

  return undefined;
}

function getLatestMessage(messages: ApiMessage[]) {
  return (
    messages.findLast((message) => message.role === "user") ?? messages.at(-1)
  );
}

function isApiMessage(message: ApiMessage | null): message is ApiMessage {
  return message !== null;
}

function toApiMessage(message: ThreadMessage): ApiMessage | null {
  if (
    message.role !== "system" &&
    message.role !== "user" &&
    message.role !== "assistant"
  ) {
    return null;
  }

  const content = message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n")
    .trim();

  if (!content) {
    return null;
  }

  return {
    role: message.role,
    content,
  };
}

async function readErrorMessage(response: Response) {
  try {
    const data = (await response.json()) as {
      error?: { message?: string };
    };

    return data.error?.message || `模型接口请求失败：HTTP ${response.status}`;
  } catch {
    return `模型接口请求失败：HTTP ${response.status}`;
  }
}

function isChatStreamResponse(response: Response) {
  return response.headers
    .get("Content-Type")
    ?.toLowerCase()
    .includes("text/event-stream");
}

async function* streamChatResponse(response: Response) {
  if (!response.ok) {
    throw new Error(await readErrorMessage(response));
  }

  if (!response.body) {
    throw new Error("模型接口没有返回可读流。");
  }

  if (!isChatStreamResponse(response)) {
    yield* readPlainTextStream(response);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const content = createAssistantContentBuilder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const updates = consumeChatSseBuffer(buffer);
    buffer = updates.remaining;

    for (const event of updates.events) {
      const update = content.apply(event);
      if (update.content.length > 0) {
        yield update.status
          ? { content: update.content, status: update.status }
          : { content: update.content };
      }
    }
  }

  buffer += decoder.decode();
  const updates = consumeChatSseBuffer(buffer, { flush: true });
  for (const event of updates.events) {
    const update = content.apply(event);
    if (update.content.length > 0) {
      yield update.status
        ? { content: update.content, status: update.status }
        : { content: update.content };
    }
  }
}

async function* readPlainTextStream(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) {
    return;
  }

  const decoder = new TextDecoder();
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    text += decoder.decode(value, { stream: true });
    yield {
      content: [{ type: "text", text } satisfies ThreadAssistantMessagePart],
    };
  }

  const tail = decoder.decode();
  if (tail) {
    text += tail;
    yield {
      content: [{ type: "text", text } satisfies ThreadAssistantMessagePart],
    };
  }
}

function consumeChatSseBuffer(
  buffer: string,
  { flush = false }: { flush?: boolean } = {},
) {
  const events: ChatStreamEvent[] = [];
  const normalizedBuffer = buffer.replace(/\r\n/g, "\n");
  const frames = normalizedBuffer.split("\n\n");
  const remaining = flush ? "" : frames.pop() ?? "";

  for (const frame of frames) {
    const event = parseChatSseEvent(frame);
    if (event) {
      events.push(event);
    }
  }

  if (flush && remaining) {
    const event = parseChatSseEvent(remaining);
    if (event) {
      events.push(event);
    }
  }

  return { events, remaining };
}

function parseChatSseEvent(frame: string): ChatStreamEvent | null {
  const trimmedFrame = frame.trim();
  if (!trimmedFrame) {
    return null;
  }

  const dataLines: string[] = [];
  let eventType = "";

  for (const line of trimmedFrame.split("\n")) {
    if (!line || line.startsWith(":")) {
      continue;
    }

    const separatorIndex = line.indexOf(":");
    const field =
      separatorIndex === -1 ? line : line.slice(0, separatorIndex);
    const value =
      separatorIndex === -1
        ? ""
        : line.slice(separatorIndex + 1).replace(/^ /, "");

    if (field === "event") {
      eventType = value;
    }

    if (field === "data") {
      dataLines.push(value);
    }
  }

  if (!dataLines.length) {
    return null;
  }

  try {
    const event = JSON.parse(dataLines.join("\n"));
    if (isChatStreamEvent(event, eventType)) {
      return event;
    }
  } catch {
    return null;
  }

  return null;
}

function createAssistantContentBuilder() {
  let structuredResponsePart: ThreadAssistantMessagePart | null = null;
  let todoStatePart: ThreadAssistantMessagePart | null = null;
  const agentRetryParts = new Map<string, ThreadAssistantMessagePart>();
  const subagentParts = new Map<string, ThreadAssistantMessagePart>();
  const filesystemChangeParts = new Map<string, ThreadAssistantMessagePart>();
  const commandResultParts = new Map<string, ThreadAssistantMessagePart>();
  const toolParts = new Map<string, ToolCallMessagePart>();
  const timelineParts: Array<
    | { id: string; kind: "agent_retry" }
    | { id: string; kind: "command_result" }
    | { id: string; kind: "filesystem_change" }
    | { id: string; kind: "subagent_state" }
    | { id: string; kind: "tool_call" }
  > = [];
  let projection = createChatStreamProjection();
  let requiresAction = false;
  let text = "";

  function ensureTimelinePart(
    part:
      | { id: string; kind: "agent_retry" }
      | { id: string; kind: "command_result" }
      | { id: string; kind: "filesystem_change" }
      | { id: string; kind: "subagent_state" }
      | { id: string; kind: "tool_call" },
  ) {
    if (
      timelineParts.some(
        (entry) => entry.kind === part.kind && entry.id === part.id,
      )
    ) {
      return;
    }

    timelineParts.push(part);
  }

  return {
    apply(event: ChatStreamEvent) {
      if (event.type === "text_delta") {
        text += event.text;
      } else if (event.type === "tool_call") {
        if (event.status === "requires_action") {
          requiresAction = true;
        }
        ensureTimelinePart({ id: event.toolCallId, kind: "tool_call" });
        toolParts.set(event.toolCallId, toToolCallPart(event));
      } else if (event.type === "structured_response") {
        structuredResponsePart = {
          type: "data",
          name: "structured_response",
          data: event.response,
        };
      } else if (event.type === "agent_retry") {
        const retryPartId = `agent_retry:${event.attempt}`;
        ensureTimelinePart({ id: retryPartId, kind: "agent_retry" });
        agentRetryParts.set(retryPartId, {
          type: "data",
          name: "agent_retry",
          data: {
            attempt: event.attempt,
            completedToolCallCount: event.completedToolCallCount,
            lastToolCall: event.lastToolCall,
            maxAttempts: event.maxAttempts,
            reason: event.reason,
            recovery: event.recovery,
          },
        });
      } else if (
        event.type === "subagent_start" ||
        event.type === "subagent_end"
      ) {
        projection = applyChatStreamProjection(projection, event);
        const subagent = projection.subagents.find(
          (candidate) => candidate.subtaskId === event.subtaskId,
        );
        if (subagent) {
          ensureTimelinePart({
            id: event.subtaskId,
            kind: "subagent_state",
          });
          subagentParts.set(event.subtaskId, {
            type: "data",
            name: "subagent_state",
            data: subagent,
          });
        }
      } else if (event.type === "filesystem_change") {
        projection = applyChatStreamProjection(projection, event);
        ensureTimelinePart({
          id: event.changeId,
          kind: "filesystem_change",
        });
        filesystemChangeParts.set(event.changeId, {
          type: "data",
          name: "filesystem_change",
          data: event,
        });
      } else if (event.type === "command_result") {
        ensureTimelinePart({
          id: event.executionId,
          kind: "command_result",
        });
        commandResultParts.set(event.executionId, {
          type: "data",
          name: "command_result",
          data: event,
        });
      } else if (event.type === "todo_update") {
        todoStatePart = {
          type: "data",
          name: "todo_state",
          data: {
            agentId: event.agentId,
            revision: event.revision,
            todos: event.todos,
            updatedAt: event.updatedAt,
          },
        };
      }

      const timelineContent = timelineParts.flatMap((part) => {
        if (part.kind === "tool_call") {
          const toolPart = toolParts.get(part.id);
          return toolPart ? [toolPart] : [];
        }

        if (part.kind === "subagent_state") {
          const subagentPart = subagentParts.get(part.id);
          return subagentPart ? [subagentPart] : [];
        }

        if (part.kind === "filesystem_change") {
          const filesystemChangePart = filesystemChangeParts.get(part.id);
          return filesystemChangePart ? [filesystemChangePart] : [];
        }

        if (part.kind === "command_result") {
          const commandResultPart = commandResultParts.get(part.id);
          return commandResultPart ? [commandResultPart] : [];
        }

        const agentRetryPart = agentRetryParts.get(part.id);
        return agentRetryPart ? [agentRetryPart] : [];
      });
      const content = [
        ...timelineContent,
        ...(todoStatePart ? [todoStatePart] : []),
        ...(text
          ? ([{ type: "text", text }] satisfies ThreadAssistantMessagePart[])
          : []),
        ...(structuredResponsePart ? [structuredResponsePart] : []),
      ];

      return {
        content,
        status: requiresAction
          ? ({
              type: "requires-action",
              reason: "tool-calls",
            } as const)
          : undefined,
      };
    },
  };
}

function toToolCallPart(event: Extract<ChatStreamEvent, { type: "tool_call" }>) {
  const args = toToolArgs(event.args);
  const displayArgs =
    event.status === "retrying" && event.retry
      ? {
          ...args,
          __retry: event.retry,
        }
      : args;

  return {
    type: "tool-call",
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    args: displayArgs as ToolCallMessagePart["args"],
    argsText: stringifyToolPayload(event.args),
    ...(event.approval ? { approval: event.approval } : {}),
    ...(event.status === "complete" ? { result: event.result } : {}),
    ...(event.status === "error"
      ? { isError: true, result: event.error ?? "工具调用失败" }
      : {}),
  } satisfies ToolCallMessagePart;
}

function toToolArgs(args: unknown): Record<string, unknown> {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }

  return {};
}

function stringifyToolPayload(value: unknown) {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return String(value);
  }
}
