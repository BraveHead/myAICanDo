export type ChatStreamEvent =
  | {
      text: string;
      type: "text_delta";
    }
  | {
      args: unknown;
      error?: string;
      result?: unknown;
      retry?: {
        attempt: number;
        error: string;
        maxRetries: number;
        nextDelayMs: number;
      };
      status: "running" | "retrying" | "complete" | "error";
      toolCallId: string;
      toolName: string;
      type: "tool_call";
    }
  | {
      response: unknown;
      type: "structured_response";
    };

export function encodeChatSseEvent(event: ChatStreamEvent) {
  return [
    `event: ${event.type}`,
    `data: ${JSON.stringify(toJsonSafeValue(event))}`,
    "",
    "",
  ].join("\n");
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
