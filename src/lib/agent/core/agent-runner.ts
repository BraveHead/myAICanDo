import { createAgent } from "langchain";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  createProjectChatModel,
  type CreateProjectChatModelOptions,
} from "./chat-model";
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
};

export function createConfiguredAgent(
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

  return createAgent({
    model,
    tools: definition.tools,
    systemPrompt: definition.systemPrompt,
  });
}

export async function* streamConfiguredAgentText({
  definition,
  messages,
  runConfig,
  signal,
  ...modelOptions
}: StreamConfiguredAgentTextOptions) {
  const agent = createConfiguredAgent(definition, modelOptions);
  const result = await agent.invoke(
    { messages },
    {
      ...runConfig,
      signal,
      recursionLimit: definition.recursionLimit ?? 8,
    },
  );
  const lastMessage = result.messages.at(-1);
  const text = normalizeMessageContent(lastMessage?.content);

  if (text) {
    yield text;
  }
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
