import type { ToolRuntime } from "@langchain/core/tools";
import { tool } from "langchain";
import * as z from "zod";
import type { AgentToolContext } from "../../core/agent-definition";
import {
  isSubagentId,
  SUBAGENT_IDS,
  type SubagentId,
  type SubagentTaskResult,
} from "./types";

const taskToolSchema = z.object({
  agent: z
    .enum(SUBAGENT_IDS)
    .describe("Subagent to run: filesystem, memory, or weather."),
  task: z
    .string()
    .min(1)
    .max(2_000)
    .describe("Single delegated task for the selected subagent."),
  context: z
    .string()
    .max(4_000)
    .optional()
    .describe("Optional extra context for the subagent."),
});

type TaskToolInput = z.infer<typeof taskToolSchema>;

export function createSubagentTools(context: AgentToolContext) {
  if (context.runSubagent === undefined) {
    return [];
  }

  return [
    tool(
      async (input, runtime?: ToolRuntime) =>
        jsonResult(await runSubagentTaskTool(input, context, runtime)),
      {
        name: "task",
        description:
          "Run one isolated read-only subagent task and return only its final report. Available subagents: filesystem, memory, weather.",
        schema: taskToolSchema,
      },
    ),
  ];
}

export async function runSubagentTaskTool(
  input: TaskToolInput,
  context: AgentToolContext,
  runtime?: Pick<ToolRuntime, "toolCallId">,
): Promise<SubagentTaskResult> {
  const subtaskId = createSubtaskId(runtime?.toolCallId);

  if (!isSubagentId(input.agent)) {
    return createTaskError({
      agent: "filesystem",
      code: "unsupported_subagent",
      message: `Unsupported subagent: ${String(input.agent)}.`,
      subtaskId,
    });
  }

  if (!context.threadId || !context.threadScope) {
    return createTaskError({
      agent: input.agent,
      code: "missing_thread_context",
      message: "task requires tenant/user/thread context.",
      subtaskId,
    });
  }

  if (!context.apiKey || !context.modelName || !context.runSubagent) {
    return createTaskError({
      agent: input.agent,
      code: "missing_runtime_context",
      message: "task requires model and subagent runtime context.",
      subtaskId,
    });
  }

  const childThreadId = createSubagentThreadId(
    context.threadId,
    subtaskId,
    input.agent,
  );

  return context.runSubagent({
    agent: input.agent,
    apiKey: context.apiKey,
    baseURL: context.baseURL,
    childThreadId,
    context: input.context,
    contextPolicy: context.contextPolicy,
    modelName: context.modelName,
    onStreamEvent: context.onStreamEvent,
    parentAgentId: "coordinator",
    parentThreadId: context.threadId,
    runConfig: context.runConfig,
    runLogger: context.runLogger,
    signal: context.signal,
    subtaskId,
    task: input.task,
    threadScope: context.threadScope,
  });
}

export function createSubagentThreadId(
  parentThreadId: string,
  subtaskId: string,
  agent: SubagentId,
) {
  return `${parentThreadId}:subtask:${subtaskId}:${agent}`;
}

export function createSubtaskId(toolCallId: string | undefined) {
  const source = toolCallId?.trim() || crypto.randomUUID();
  const safeSource = source.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  return `task_${safeSource}`;
}

function createTaskError({
  agent,
  code,
  message,
  subtaskId,
}: {
  agent: SubagentId;
  code: string;
  message: string;
  subtaskId: string;
}): SubagentTaskResult {
  return {
    agent,
    error: {
      code,
      message,
    },
    ok: false,
    subtaskId,
    summary: `子任务执行失败：${message}`,
  };
}

function jsonResult(value: unknown) {
  return JSON.stringify(value);
}
