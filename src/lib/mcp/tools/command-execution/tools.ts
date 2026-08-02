import { McpPublicError } from "../../core/errors";
import {
  defineMcpTool,
  readonlyToolAnnotations,
  type McpToolDefinition,
} from "../../core/tool-definition";
import {
  defaultCommandExecutionMcpPort,
  listExecutionItems,
  readExecution,
  type CommandExecutionMcpPort,
} from "./adapter";
import {
  getCommandExecutionInputSchema,
  getCommandExecutionOutputSchema,
  listCommandExecutionsInputSchema,
  listCommandExecutionsOutputSchema,
} from "./contracts";

export function createCommandExecutionMcpTools(
  port: CommandExecutionMcpPort = defaultCommandExecutionMcpPort,
): McpToolDefinition[] {
  return [
    defineMcpTool({
      access: { kind: "thread" },
      annotations: {
        ...readonlyToolAnnotations,
        title: "列出命令执行任务",
      },
      description:
        "列出已持久化线程最近的命令执行任务。返回轻量摘要，不包含 stdout、stderr 或完整结果。",
      execute: async (input, { trustedScope }) => {
        const executions = await listExecutionItems(
          trustedScope,
          input.limit,
          port,
        );
        return {
          count: executions.length,
          executions,
          ok: true,
        };
      },
      inputSchema: listCommandExecutionsInputSchema,
      name: "list_command_executions",
      outputSchema: listCommandExecutionsOutputSchema,
      title: "列出命令执行任务",
    }),
    defineMcpTool({
      access: { kind: "thread" },
      annotations: {
        ...readonlyToolAnnotations,
        title: "读取命令执行任务",
      },
      description:
        "读取一个属于当前工作区和线程的命令执行任务，包括受 M10 输出上限约束的 stdout、stderr 与最终结果。",
      execute: async (input, { trustedScope }) => {
        const execution = await readExecution(
          trustedScope,
          input.executionId,
          port,
        );
        if (!execution) {
          throw new McpPublicError(
            "execution_not_found",
            "命令执行任务不存在或不属于当前作用域。",
          );
        }
        return {
          execution,
          ok: true,
        };
      },
      inputSchema: getCommandExecutionInputSchema,
      name: "get_command_execution",
      outputSchema: getCommandExecutionOutputSchema,
      title: "读取命令执行任务",
    }),
  ];
}
