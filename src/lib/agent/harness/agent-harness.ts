import { createAgent, type AnyAgentMiddleware } from "langchain";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { Logger } from "pino";
import type { ChatStreamEvent } from "@/lib/chat-stream";
import type { ThreadScope } from "@/lib/server/thread-store/persistence";
import { buildHarnessSystemPrompt, type ContextOffloadPolicy } from "./context";
import type { TodoState } from "./planning";
import { createPlanningTools } from "./tools";
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
  contextPolicy?: ContextOffloadPolicy;
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
  contextPolicy?: ContextOffloadPolicy;
  createMiddleware: AgentHarnessMiddlewareFactory;
  definition: AgentDefinition;
  getCheckpointer: () => Promise<TCheckpointer>;
  getCheckpointerType: (checkpointer: TCheckpointer) => string;
  memoryContext?: string;
  onStreamEvent?: (event: ChatStreamEvent) => void;
  runLogger?: Logger;
  threadId?: string;
  threadScope?: ThreadScope;
  todoState?: TodoState | null;
};

export async function createHarnessedAgent<
  TCheckpointer extends BaseCheckpointSaver | boolean,
>({
  apiKey,
  baseURL,
  contextPolicy,
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
  todoState,
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
    contextPolicy,
    onStreamEvent,
    runLogger,
    threadId,
    threadScope,
  });
  const tools = [
    ...resolveAgentTools(definition, {
      threadId,
      threadScope,
    }),
    ...createPlanningTools({
      agentId: definition.id,
      onStreamEvent,
      threadId,
      threadScope,
    }),
  ];

  runLogger?.debug(
    {
      checkpointer: getCheckpointerType(agentCheckpointer),
      hasContextPolicy: Boolean(contextPolicy),
      hasMemoryContext: Boolean(memoryContext),
      hasResponseFormat: Boolean(definition.responseFormat),
      hasTodoState: Boolean(todoState?.todos.length),
      toolCount: tools.length,
    },
    "agent configured",
  );

  return createAgent({
    model,
    tools,
    systemPrompt: buildHarnessSystemPrompt({
      agentPrompt: definition.systemPrompt,
      memoryContext,
      offloadPolicy: contextPolicy,
      todoState,
    }),
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
