import type { ClientTool, ServerTool } from "@langchain/core/tools";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { ResponseFormat } from "langchain";
import type { Logger } from "pino";
import type { ChatStreamEvent } from "@/lib/chat-stream";
import type { ThreadScope } from "@/lib/server/thread-store/persistence";
import type { ContextOffloadPolicy } from "../harness/context";
import type { RunSubagentTask } from "../harness/subagents";
import type { CreateProjectChatModelOptions } from "./chat-model";
import type { SupportedAgent } from "../shared/agent-ids";
import type { MemoryManifest } from "../harness/memory";

export type AgentMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type AgentTool = ClientTool | ServerTool;

export type AgentToolContext = {
  apiKey?: string;
  baseURL?: string;
  contextPolicy?: ContextOffloadPolicy;
  modelName?: string;
  memoryManifest?: MemoryManifest;
  onStreamEvent?: (event: ChatStreamEvent) => void;
  runConfig?: RunnableConfig;
  runLogger?: Logger;
  runSubagent?: RunSubagentTask;
  signal?: AbortSignal;
  threadId?: string;
  threadScope?: ThreadScope;
};

type AgentTools =
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
