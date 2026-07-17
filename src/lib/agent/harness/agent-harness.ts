import { createAgent, type AnyAgentMiddleware } from "langchain";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { Logger } from "pino";
import type { ChatStreamEvent } from "@/lib/chat-stream";
import type { ThreadScope } from "@/lib/server/thread-store/persistence";
import { buildHarnessSystemPrompt, type ContextOffloadPolicy } from "./context";
import type { TodoState } from "./planning";
import type { MemoryManifest } from "./memory";
import {
  createSkillTools,
  formatSkillSummariesForPrompt,
  listSkillsForAgent,
} from "./skills";
import { createSubagentTools, type RunSubagentTask } from "./subagents";
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

type AgentHarnessMiddlewareFactoryOptions = {
  agentId: AgentDefinition["id"];
  contextPolicy?: ContextOffloadPolicy;
  onStreamEvent?: (event: ChatStreamEvent) => void;
  runLogger?: Logger;
  threadId?: string;
  threadScope?: ThreadScope;
};

type AgentHarnessMiddlewareFactory = (
  options: AgentHarnessMiddlewareFactoryOptions,
) => readonly AnyAgentMiddleware[];

type AgentHarnessConfig<
  TCheckpointer extends
    BaseCheckpointSaver | boolean = BaseCheckpointSaver | boolean,
> = CreateConfiguredAgentOptions & {
  contextPolicy?: ContextOffloadPolicy;
  createMiddleware: AgentHarnessMiddlewareFactory;
  definition: AgentDefinition;
  getCheckpointer: () => Promise<TCheckpointer>;
  getCheckpointerType: (checkpointer: TCheckpointer) => string;
  memoryContext?: string;
  memoryManifest?: MemoryManifest;
  onStreamEvent?: (event: ChatStreamEvent) => void;
  planningEnabled?: boolean;
  runConfig?: RunnableConfig;
  runLogger?: Logger;
  runSubagent?: RunSubagentTask;
  signal?: AbortSignal;
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
  memoryManifest,
  modelName,
  onStreamEvent,
  planningEnabled = true,
  runConfig,
  runLogger,
  runSubagent,
  signal,
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
  const skillListResult = await listSkillsForAgent({
    agentId: definition.id,
  });
  const skillSummaries = skillListResult.ok ? skillListResult.skills : [];
  const skillsContext = formatSkillSummariesForPrompt(skillSummaries);
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
      apiKey,
      baseURL,
      contextPolicy,
      modelName,
      memoryManifest,
      onStreamEvent,
      runConfig,
      runLogger,
      runSubagent,
      signal,
      threadId,
      threadScope,
    }),
    ...(definition.id === "coordinator"
      ? createSubagentTools({
          apiKey,
          baseURL,
          contextPolicy,
          modelName,
          memoryManifest,
          onStreamEvent,
          runConfig,
          runLogger,
          runSubagent,
          signal,
          threadId,
          threadScope,
        })
      : []),
    ...createSkillTools({
      agentId: definition.id,
      runLogger,
    }),
    ...(planningEnabled
      ? createPlanningTools({
          agentId: definition.id,
          onStreamEvent,
          threadId,
          threadScope,
        })
      : []),
  ];

  runLogger?.debug(
    {
      checkpointer: getCheckpointerType(agentCheckpointer),
      hasContextPolicy: Boolean(contextPolicy),
      hasMemoryContext: Boolean(memoryContext),
      memoryEntryCounts: memoryManifest
        ? {
            harness: 1,
            project: memoryManifest.project.length,
            user: memoryManifest.user.length,
          }
        : undefined,
      hasPlanningTools: planningEnabled,
      hasSkillsContext: Boolean(skillsContext),
      hasResponseFormat: Boolean(definition.responseFormat),
      hasTodoState: Boolean(todoState?.todos.length),
      skillCount: skillSummaries.length,
      toolCount: tools.length,
    },
    "agent configured",
  );

  return createAgent({
    name: definition.id,
    model,
    tools,
    systemPrompt: buildHarnessSystemPrompt({
      agentPrompt: definition.systemPrompt,
      memoryContext,
      memoryManifest,
      offloadPolicy: contextPolicy,
      planningEnabled,
      skillsContext,
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
