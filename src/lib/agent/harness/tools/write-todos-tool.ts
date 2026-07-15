import { tool } from "langchain";
import * as z from "zod";
import type { ChatStreamEvent } from "@/lib/chat-stream";
import type { ThreadScope } from "@/lib/server/thread-store/persistence";
import { writeThreadTodoState } from "../planning/todo-store";
import { TODO_STATUSES, type TodoInputItem } from "../planning/types";

type PlanningToolContext = {
  agentId: string;
  onStreamEvent?: (event: ChatStreamEvent) => void;
  threadId?: string;
  threadScope?: ThreadScope;
};

const todoInputSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe("Stable todo id returned by a previous write_todos call."),
  content: z
    .string()
    .min(1)
    .max(240)
    .describe("Concise task description."),
  status: z
    .enum(TODO_STATUSES)
    .describe("Current task status: pending, in_progress, or completed."),
});

export function createPlanningTools(context: PlanningToolContext) {
  return [
    tool(
      async ({ todos }) => {
        if (!context.threadId || !context.threadScope) {
          return jsonResult({
            ok: false,
            summary: "缺少 tenant/user/thread 上下文，无法写入任务状态。",
            error: {
              code: "missing_thread_context",
              message: "write_todos requires tenant/user/thread context.",
            },
          });
        }

        const result = await writeThreadTodoState(context.threadScope, {
          agentId: context.agentId,
          threadId: context.threadId,
          todos,
        });

        if (result.ok) {
          context.onStreamEvent?.({
            type: "todo_update",
            ...result.state,
          });
        }

        return jsonResult(result);
      },
      {
        name: "write_todos",
        description:
          "Create or replace the current thread task plan. Use this for multi-step work, analysis, file/report tasks, and long-running agent workflows; keep exactly one task in_progress at a time.",
        schema: z.object({
          todos: z
            .array(todoInputSchema)
            .max(20)
            .describe(
              "The complete current todo list. Include prior ids when updating existing tasks.",
            ),
        }),
      },
    ),
  ];
}

function jsonResult(value: unknown) {
  return JSON.stringify(value);
}

export type WriteTodosToolInput = {
  todos: TodoInputItem[];
};
