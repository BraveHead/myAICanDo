import { createAgent } from "langchain";
import { MemorySaver } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { RunnableConfig } from "@langchain/core/runnables";
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
  runConfig?: RunnableConfig;
  signal: AbortSignal;
  threadId?: string;
};

type AgentCheckpointer = MemorySaver | PostgresSaver;

let checkpointer: AgentCheckpointer | null = null;
let checkpointerPromise: Promise<AgentCheckpointer> | null = null;
const initializedAgentThreads = new Set<string>();

export async function createConfiguredAgent(
  definition: AgentDefinition,
  { apiKey, baseURL, modelName }: CreateConfiguredAgentOptions,
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

  return createAgent({
    model,
    tools: definition.tools,
    systemPrompt: definition.systemPrompt,
    checkpointer: agentCheckpointer,
  });
}

export async function* streamConfiguredAgentText({
  definition,
  messages,
  runConfig,
  signal,
  threadId,
  ...modelOptions
}: StreamConfiguredAgentTextOptions) {
  const agent = await createConfiguredAgent(definition, modelOptions);
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
  const result = await runWithTimeout(
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
  );
  if (agentThreadId) {
    initializedAgentThreads.add(agentThreadId);
  }

  const lastMessage = result.messages.at(-1);
  const text = normalizeMessageContent(lastMessage?.content);

  if (text) {
    yield text;
  }
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
