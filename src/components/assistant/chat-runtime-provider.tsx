"use client";

import {
  AssistantRuntimeProvider,
  useLocalRuntime,
  type ChatModelAdapter,
  type ThreadMessage,
} from "@assistant-ui/react";
import { type PropsWithChildren, useMemo } from "react";
import {
  isSupportedAgent,
  type SupportedAgent,
} from "@/lib/agent/shared/agent-ids";

type ApiMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export function ChatRuntimeProvider({ children }: PropsWithChildren) {
  const adapter = useMemo<ChatModelAdapter>(
    () => ({
      async *run({ messages, abortSignal, unstable_threadId, runConfig }) {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messages: messages.map(toApiMessage).filter(Boolean),
            model:
              typeof runConfig.custom?.model === "string"
                ? runConfig.custom.model
                : undefined,
            agent: getSupportedAgent(runConfig.custom?.agent),
            threadId: unstable_threadId,
          }),
          signal: abortSignal,
        });

        if (!response.ok) {
          throw new Error(await readErrorMessage(response));
        }

        if (!response.body) {
          throw new Error("模型接口没有返回可读流。");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let text = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          text += decoder.decode(value, { stream: true });
          yield {
            content: [{ type: "text", text }],
          };
        }

        const tail = decoder.decode();
        if (tail) {
          text += tail;
          yield {
            content: [{ type: "text", text }],
          };
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
