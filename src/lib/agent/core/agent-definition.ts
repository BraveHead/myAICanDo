import type { ClientTool, ServerTool } from "@langchain/core/tools";
import type { ResponseFormat } from "langchain";
import type { ThreadScope } from "@/lib/server/thread-store/persistence";
import type { CreateProjectChatModelOptions } from "./chat-model";
import type { SupportedAgent } from "../shared/agent-ids";

export type AgentMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type AgentTool = ClientTool | ServerTool;

export type AgentToolContext = {
  threadId?: string;
  threadScope?: ThreadScope;
};

export type AgentTools =
  | AgentTool[]
  | ((context: AgentToolContext) => AgentTool[]);

export type AgentDefinition = {
  id: SupportedAgent;
  systemPrompt: string;
  tools: AgentTools;
  modelOptions?: Pick<CreateProjectChatModelOptions, "temperature" | "timeout">;
  responseFormat?: ResponseFormat | ResponseFormat[];
  recursionLimit?: number;
  match?: (content: string) => boolean;
};

export type CreateConfiguredAgentOptions = Pick<
  CreateProjectChatModelOptions,
  "apiKey" | "baseURL" | "modelName"
>;
