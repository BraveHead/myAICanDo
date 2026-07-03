"use client";

import {
  AssistantRuntimeProvider,
  useLocalRuntime,
  type ChatModelAdapter,
  type ThreadAssistantMessagePart,
  type ThreadMessage,
  type ToolCallMessagePart,
} from "@assistant-ui/react";
import { type PropsWithChildren, useMemo } from "react";
import {
  isSupportedAgent,
  type SupportedAgent,
} from "@/lib/agent/shared/agent-ids";
import type { ChatStreamEvent } from "@/lib/chat-stream";
import { loadActiveThreadId } from "@/lib/thread-storage";

type ApiMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export function ChatRuntimeProvider({ children }: PropsWithChildren) {
  const adapter = useMemo<ChatModelAdapter>(
    () => ({
      async *run({ messages, abortSignal, unstable_threadId, runConfig }) {
        const apiMessages = messages.map(toApiMessage).filter(isApiMessage);
        const latestMessage = getLatestMessage(apiMessages);

        if (!latestMessage) {
          throw new Error("没有可发送的用户消息。");
        }

        const response = await fetch("/api/chat", {
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
            threadId: loadActiveThreadId() ?? unstable_threadId,
          }),
          signal: abortSignal,
        });

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
            const nextContent = content.apply(event);
            if (nextContent.length > 0) {
              yield { content: nextContent };
            }
          }
        }

        buffer += decoder.decode();
        const updates = consumeChatSseBuffer(buffer, { flush: true });
        for (const event of updates.events) {
          const nextContent = content.apply(event);
          if (nextContent.length > 0) {
            yield { content: nextContent };
          }
        }
      },
    }),
    [],
  );
  const runtime = useLocalRuntime(adapter);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
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
    const event = JSON.parse(dataLines.join("\n")) as ChatStreamEvent;
    if (
      event.type === eventType &&
      (event.type === "text_delta" ||
        event.type === "tool_call" ||
        event.type === "structured_response")
    ) {
      return event;
    }
  } catch {
    return null;
  }

  return null;
}

function createAssistantContentBuilder() {
  let structuredResponsePart: ThreadAssistantMessagePart | null = null;
  const toolParts = new Map<string, ToolCallMessagePart>();
  let text = "";

  return {
    apply(event: ChatStreamEvent) {
      if (event.type === "text_delta") {
        text += event.text;
      } else if (event.type === "tool_call") {
        toolParts.set(event.toolCallId, toToolCallPart(event));
      } else {
        structuredResponsePart = {
          type: "data",
          name: "structured_response",
          data: event.response,
        };
      }

      return [
        ...toolParts.values(),
        ...(text
          ? ([{ type: "text", text }] satisfies ThreadAssistantMessagePart[])
          : []),
        ...(structuredResponsePart ? [structuredResponsePart] : []),
      ];
    },
  };
}

function toToolCallPart(event: Extract<ChatStreamEvent, { type: "tool_call" }>) {
  return {
    type: "tool-call",
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    args: toToolArgs(event.args) as ToolCallMessagePart["args"],
    argsText: stringifyToolPayload(event.args),
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
