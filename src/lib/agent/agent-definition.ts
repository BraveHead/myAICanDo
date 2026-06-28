import type { ClientTool, ServerTool } from "@langchain/core/tools";
import type { CreateProjectChatModelOptions } from "./chat-model";
import type { SupportedAgent } from "./agent-ids";

export type AgentMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type AgentDefinition = {
  id: SupportedAgent;
  systemPrompt: string;
  tools: (ClientTool | ServerTool)[];
  modelOptions?: Pick<CreateProjectChatModelOptions, "temperature" | "timeout">;
  recursionLimit?: number;
  match?: (content: string) => boolean;
};

export type CreateConfiguredAgentOptions = Pick<
  CreateProjectChatModelOptions,
  "apiKey" | "baseURL" | "modelName"
>;
