import { tool } from "langchain";
import * as z from "zod";
import {
  COMMAND_DEFAULT_TIMEOUT_MS,
  COMMAND_MAX_TIMEOUT_MS,
  executeCommandInSandbox,
  type CommandExecutionContext,
} from "@/lib/agent/services/command-execution";

export function createExecuteCommandTool(context: CommandExecutionContext) {
  return tool(
    async ({ args, command, cwd, timeoutMs }) =>
      JSON.stringify(
        await executeCommandInSandbox(
          {
            args,
            command,
            cwd,
            timeoutMs,
          },
          context,
        ),
      ),
    {
      name: "execute_command",
      description:
        "在当前 thread sandbox 的 workspace 或 notes 目录中执行一个受安全策略限制的只读命令。命令不会访问网络、项目仓库或环境 secrets，且必须经过用户确认。不要使用 shell、管道、重定向或后台命令。",
      schema: z
        .object({
          command: z
            .string()
            .min(1)
            .max(64)
            .describe("Allowlisted executable name, such as pwd, ls, rg, or bun."),
          args: z
            .array(z.string().max(512))
            .max(32)
            .optional()
            .describe("Arguments passed directly to the executable; no shell syntax."),
          cwd: z
            .string()
            .min(1)
            .optional()
            .default("workspace")
            .describe("Relative directory under workspace/ or notes/."),
          timeoutMs: z
            .number()
            .int()
            .min(1_000)
            .max(COMMAND_MAX_TIMEOUT_MS)
            .optional()
            .default(COMMAND_DEFAULT_TIMEOUT_MS)
            .describe("Execution timeout in milliseconds."),
        })
        .strict(),
    },
  );
}
