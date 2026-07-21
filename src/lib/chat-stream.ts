import type { TodoState } from "@/lib/agent/harness/planning/types";
import type { CommandExecutionStatus } from "@/lib/agent/services/command-execution";

export type SubagentId = "filesystem" | "memory" | "weather";
export type ToolCallStatus =
  | "running"
  | "retrying"
  | "requires_action"
  | "complete"
  | "error";

export type SubagentStartEvent = {
  agent: SubagentId;
  parentAgentId: string;
  startedAt: string;
  subtaskId: string;
  taskSummary: string;
  type: "subagent_start";
};

export type SubagentEndEvent = {
  agent: SubagentId;
  durationMs: number;
  error?: string;
  finishedAt: string;
  status: "completed" | "failed";
  subtaskId: string;
  summary: string;
  type: "subagent_end";
};

export type FilesystemChangeEvent = {
  approvalId?: string;
  changeId: string;
  operation: "create" | "overwrite" | "edit" | "delete";
  path: string;
  replacements?: number;
  sizeBytes?: number;
  status: "completed" | "rejected" | "failed";
  summary: string;
  toolCallId?: string;
  type: "filesystem_change";
};

export type CommandResultEvent = {
  approvalId?: string;
  args: string[];
  command: string;
  cwd: string;
  durationMs: number;
  executionId: string;
  exitCode?: number | null;
  finishedAt: string;
  outputTruncated: boolean;
  status: CommandExecutionStatus;
  stderr: string;
  stdout: string;
  summary: string;
  type: "command_result";
};

export type ChatStreamEvent =
  | {
      text: string;
      type: "text_delta";
    }
  | {
      args: unknown;
      error?: string;
      result?: unknown;
      approval?: {
        id: string;
        approved?: boolean;
        reason?: string;
        isAutomatic?: boolean;
        options?: Array<{
          id: string;
          kind: string;
          label?: string;
          description?: string;
          grants?: string[];
          confirm?: boolean | { title?: string; description?: string };
        }>;
        optionId?: string;
        preview?: unknown;
        resolution?: "cancelled" | "expired";
      };
      retry?: {
        attempt: number;
        error: string;
        maxRetries: number;
        nextDelayMs: number;
      };
      status: ToolCallStatus;
      toolCallId: string;
      toolName: string;
      type: "tool_call";
    }
  | {
      response: unknown;
      type: "structured_response";
    }
  | {
      attempt: number;
      completedToolCallCount: number;
      lastToolCall?: {
        toolCallId: string;
        toolName: string;
      };
      maxAttempts: number;
      reason: string;
      recovery: "checkpoint";
      type: "agent_retry";
    }
  | ({
      type: "todo_update";
    } & TodoState)
  | SubagentStartEvent
  | SubagentEndEvent
  | FilesystemChangeEvent
  | CommandResultEvent;

const CHAT_STREAM_EVENT_TYPES = new Set<ChatStreamEvent["type"]>([
  "text_delta",
  "tool_call",
  "structured_response",
  "agent_retry",
  "todo_update",
  "subagent_start",
  "subagent_end",
  "filesystem_change",
  "command_result",
]);

export function encodeChatSseEvent(event: ChatStreamEvent) {
  return [
    `event: ${event.type}`,
    `data: ${JSON.stringify(toJsonSafeValue(event))}`,
    "",
    "",
  ].join("\n");
}

export function isChatStreamEvent(
  value: unknown,
  eventType?: string,
): value is ChatStreamEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Partial<ChatStreamEvent>;
  if (
    typeof candidate.type !== "string" ||
    !CHAT_STREAM_EVENT_TYPES.has(candidate.type as ChatStreamEvent["type"])
  ) {
    return false;
  }

  if (eventType && candidate.type !== eventType) {
    return false;
  }

  if (candidate.type === "todo_update") {
    return isTodoUpdateEvent(candidate);
  }

  if (candidate.type === "agent_retry") {
    return isAgentRetryEvent(candidate);
  }

  if (candidate.type === "subagent_start") {
    return isSubagentStartEvent(candidate);
  }

  if (candidate.type === "subagent_end") {
    return isSubagentEndEvent(candidate);
  }

  if (candidate.type === "filesystem_change") {
    return isFilesystemChangeEvent(candidate);
  }

  if (candidate.type === "command_result") {
    return isCommandResultEvent(candidate);
  }

  if (candidate.type === "text_delta") {
    return typeof candidate.text === "string";
  }

  if (candidate.type === "tool_call") {
    return (
      typeof candidate.toolCallId === "string" &&
      typeof candidate.toolName === "string" &&
      isToolCallStatus(candidate.status)
    );
  }

  if (candidate.type === "structured_response") {
    return "response" in candidate;
  }

  return true;
}

function toJsonSafeValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(toJsonSafeValue);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      toJsonSafeValue(entry),
    ]),
  );
}

function isTodoUpdateEvent(value: Partial<ChatStreamEvent>) {
  const candidate = value as Partial<Extract<ChatStreamEvent, { type: "todo_update" }>>;
  return (
    typeof candidate.agentId === "string" &&
    typeof candidate.revision === "number" &&
    Array.isArray(candidate.todos) &&
    typeof candidate.updatedAt === "string"
  );
}

function isAgentRetryEvent(value: Partial<ChatStreamEvent>) {
  const candidate = value as Partial<Extract<ChatStreamEvent, { type: "agent_retry" }>>;
  const lastToolCall = candidate.lastToolCall;
  const hasValidLastToolCall =
    lastToolCall === undefined ||
    (typeof lastToolCall === "object" &&
      !Array.isArray(lastToolCall) &&
      typeof lastToolCall.toolCallId === "string" &&
      typeof lastToolCall.toolName === "string");

  return (
    typeof candidate.attempt === "number" &&
    typeof candidate.completedToolCallCount === "number" &&
    hasValidLastToolCall &&
    typeof candidate.maxAttempts === "number" &&
    typeof candidate.reason === "string" &&
    candidate.recovery === "checkpoint"
  );
}

function isSubagentStartEvent(value: Partial<ChatStreamEvent>) {
  const candidate = value as Partial<SubagentStartEvent>;
  return (
    isSubagentId(candidate.agent) &&
    typeof candidate.parentAgentId === "string" &&
    typeof candidate.startedAt === "string" &&
    typeof candidate.subtaskId === "string" &&
    typeof candidate.taskSummary === "string"
  );
}

function isSubagentEndEvent(value: Partial<ChatStreamEvent>) {
  const candidate = value as Partial<SubagentEndEvent>;
  return (
    isSubagentId(candidate.agent) &&
    typeof candidate.durationMs === "number" &&
    Number.isFinite(candidate.durationMs) &&
    (candidate.error === undefined || typeof candidate.error === "string") &&
    typeof candidate.finishedAt === "string" &&
    (candidate.status === "completed" || candidate.status === "failed") &&
    typeof candidate.subtaskId === "string" &&
    typeof candidate.summary === "string"
  );
}

function isFilesystemChangeEvent(value: Partial<ChatStreamEvent>) {
  const candidate = value as Partial<FilesystemChangeEvent>;
  return (
    (candidate.approvalId === undefined || typeof candidate.approvalId === "string") &&
    typeof candidate.changeId === "string" &&
    (candidate.operation === "create" ||
      candidate.operation === "overwrite" ||
      candidate.operation === "edit" ||
      candidate.operation === "delete") &&
    typeof candidate.path === "string" &&
    (candidate.replacements === undefined ||
      (typeof candidate.replacements === "number" &&
        Number.isFinite(candidate.replacements))) &&
    (candidate.sizeBytes === undefined ||
      (typeof candidate.sizeBytes === "number" &&
        Number.isFinite(candidate.sizeBytes))) &&
    (candidate.status === "completed" ||
      candidate.status === "rejected" ||
      candidate.status === "failed") &&
    typeof candidate.summary === "string" &&
    (candidate.toolCallId === undefined || typeof candidate.toolCallId === "string")
  );
}

function isCommandResultEvent(value: Partial<ChatStreamEvent>) {
  const candidate = value as Partial<CommandResultEvent>;
  return (
    (candidate.approvalId === undefined || typeof candidate.approvalId === "string") &&
    Array.isArray(candidate.args) &&
    candidate.args.every((arg) => typeof arg === "string") &&
    typeof candidate.command === "string" &&
    typeof candidate.cwd === "string" &&
    typeof candidate.durationMs === "number" &&
    Number.isFinite(candidate.durationMs) &&
    typeof candidate.executionId === "string" &&
    (candidate.exitCode === undefined ||
      candidate.exitCode === null ||
      typeof candidate.exitCode === "number") &&
    typeof candidate.finishedAt === "string" &&
    typeof candidate.outputTruncated === "boolean" &&
    isCommandExecutionStatus(candidate.status) &&
    typeof candidate.stderr === "string" &&
    typeof candidate.stdout === "string" &&
    typeof candidate.summary === "string"
  );
}

function isCommandExecutionStatus(value: unknown): value is CommandExecutionStatus {
  return (
    value === "completed" ||
    value === "failed" ||
    value === "timed_out" ||
    value === "rejected" ||
    value === "sandbox_unavailable"
  );
}

function isSubagentId(value: unknown): value is SubagentId {
  return value === "filesystem" || value === "memory" || value === "weather";
}

function isToolCallStatus(value: unknown): value is ToolCallStatus {
  return (
    value === "running" ||
    value === "retrying" ||
    value === "requires_action" ||
    value === "complete" ||
    value === "error"
  );
}
