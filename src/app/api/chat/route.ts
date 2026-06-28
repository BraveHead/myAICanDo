import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { createProjectChatModel } from "@/lib/agent/core/chat-model";
import type { AgentMessage } from "@/lib/agent/core/agent-definition";
import { resolveAgentDefinition } from "@/lib/agent/core/agent-registry";
import { streamConfiguredAgentText } from "@/lib/agent/core/agent-runner";
import { createLangSmithRunConfig } from "@/lib/agent/core/langsmith-tracing";
import type { SupportedAgent } from "@/lib/agent/shared/agent-ids";

type ChatRequestMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type ChatRequestBody = {
  messages?: ChatRequestMessage[];
  model?: string;
  threadId?: string;
  agent?: SupportedAgent;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: ChatRequestBody;

  try {
    body = (await request.json()) as ChatRequestBody;
  } catch {
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

  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) {
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

  const encoder = new TextEncoder();
  const agentMessages: AgentMessage[] = messages.map((message) => ({
    role: message.role,
    content: message.content,
  }));
  const langChainMessages = messages.map((message) => {
    if (message.role === "system") {
      return new SystemMessage(message.content);
    }

    if (message.role === "assistant") {
      return new AIMessage(message.content);
    }

    return new HumanMessage(message.content);
  });
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const agentDefinition = resolveAgentDefinition({
          agent: body.agent,
          messages: agentMessages,
        });
        const runConfig = createLangSmithRunConfig({
          agent: agentDefinition?.id,
          modelName,
          threadId: body.threadId,
        });
        const chunks =
          agentDefinition !== undefined
            ? streamConfiguredAgentText({
                definition: agentDefinition,
                apiKey,
                baseURL,
                modelName,
                messages: agentMessages,
                runConfig,
                signal: request.signal,
              })
            : streamChatModelText({
                model: createProjectChatModel({
                  apiKey,
                  baseURL,
                  modelName,
                }),
                messages: langChainMessages,
                runConfig,
                signal: request.signal,
              });

        for await (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }

        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    cancel() {
      request.signal.throwIfAborted();
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "X-Thread-Id": body.threadId ?? "",
    },
  });
}

async function* streamChatModelText({
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
      yield text;
    }
  }
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
