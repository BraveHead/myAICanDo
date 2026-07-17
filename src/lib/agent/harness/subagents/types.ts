import type { RunnableConfig } from "@langchain/core/runnables";
import type { Logger } from "pino";
import type { ChatStreamEvent } from "@/lib/chat-stream";
import type { ThreadScope } from "@/lib/server/thread-store/persistence";
import type { ContextOffloadPolicy } from "../context";
import type { MemoryManifest } from "../memory";

export const SUBAGENT_IDS = ["filesystem", "memory", "weather"] as const;

export type SubagentId = (typeof SUBAGENT_IDS)[number];

export type SubagentToolResult = {
  summary: string;
  toolName: string;
};

type SubagentTaskError = {
  code: string;
  message: string;
};

export type SubagentTaskResult =
  | {
      agent: SubagentId;
      childThreadId: string;
      ok: true;
      subtaskId: string;
      summary: string;
      toolResults: SubagentToolResult[];
    }
  | {
      agent: SubagentId;
      childThreadId?: string;
      error: SubagentTaskError;
      ok: false;
      subtaskId: string;
      summary: string;
      toolResults?: SubagentToolResult[];
    };

export type RunSubagentTaskInput = {
  agent: SubagentId;
  apiKey: string;
  baseURL?: string;
  childThreadId: string;
  context?: string;
  contextPolicy?: ContextOffloadPolicy;
  modelName: string;
  memoryManifest?: MemoryManifest;
  onStreamEvent?: (event: ChatStreamEvent) => void;
  parentAgentId: string;
  parentThreadId: string;
  runConfig?: RunnableConfig;
  runLogger?: Logger;
  signal?: AbortSignal;
  subtaskId: string;
  task: string;
  threadScope: ThreadScope;
};

export type RunSubagentTask = (
  input: RunSubagentTaskInput,
) => Promise<SubagentTaskResult>;

export function isSubagentId(value: unknown): value is SubagentId {
  return SUBAGENT_IDS.some((agentId) => agentId === value);
}
