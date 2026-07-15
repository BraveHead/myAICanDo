import type { TodoState } from "@/lib/agent/harness/planning/types";

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
      status: "running" | "retrying" | "requires_action" | "complete" | "error";
      toolCallId: string;
      toolName: string;
      type: "tool_call";
    }
  | {
      response: unknown;
      type: "structured_response";
    }
  | ({
      type: "todo_update";
    } & TodoState);

const CHAT_STREAM_EVENT_TYPES = new Set<ChatStreamEvent["type"]>([
  "text_delta",
  "tool_call",
  "structured_response",
  "todo_update",
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
