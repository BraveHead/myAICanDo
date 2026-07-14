import { createAgent, type AnyAgentMiddleware } from "langchain";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { Logger } from "pino";
import type { ChatStreamEvent } from "@/lib/chat-stream";
import type { ThreadScope } from "@/lib/server/thread-store/persistence";
import type {
  AgentDefinition,
  AgentToolContext,
  CreateConfiguredAgentOptions,
} from "../core/agent-definition";
import {
  createProjectChatModel,
  type CreateProjectChatModelOptions,
} from "../core/chat-model";

export type AgentHarnessMiddlewareFactoryOptions = {
  agentId: AgentDefinition["id"];
  onStreamEvent?: (event: ChatStreamEvent) => void;
  runLogger?: Logger;
  threadId?: string;
  threadScope?: ThreadScope;
};

export type AgentHarnessMiddlewareFactory = (
  options: AgentHarnessMiddlewareFactoryOptions,
) => readonly AnyAgentMiddleware[];

export type AgentHarnessConfig<
  TCheckpointer extends
    BaseCheckpointSaver | boolean = BaseCheckpointSaver | boolean,
> = CreateConfiguredAgentOptions & {
  createMiddleware: AgentHarnessMiddlewareFactory;
  definition: AgentDefinition;
  getCheckpointer: () => Promise<TCheckpointer>;
  getCheckpointerType: (checkpointer: TCheckpointer) => string;
  memoryContext?: string;
  onStreamEvent?: (event: ChatStreamEvent) => void;
  runLogger?: Logger;
  threadId?: string;
  threadScope?: ThreadScope;
};

export async function createHarnessedAgent<
  TCheckpointer extends BaseCheckpointSaver | boolean,
>({
  apiKey,
  baseURL,
  createMiddleware,
  definition,
  getCheckpointer,
  getCheckpointerType,
  memoryContext,
  modelName,
  onStreamEvent,
  runLogger,
  threadId,
  threadScope,
}: AgentHarnessConfig<TCheckpointer>) {
  const modelOptions: CreateProjectChatModelOptions = {
    apiKey,
    baseURL,
    modelName,
    temperature: definition.modelOptions?.temperature,
    timeout: definition.modelOptions?.timeout,
  };
  const model = createProjectChatModel(modelOptions);
  const agentCheckpointer = await getCheckpointer();
  const middleware = createMiddleware({
    agentId: definition.id,
    onStreamEvent,
    runLogger,
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
