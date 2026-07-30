import * as repository from "./execution-repository";
import {
  createCommandSummary,
  resolveSandboxExecutionRequest,
  validateExecuteCommandArgs,
  type ValidatedCommandArgs,
} from "./command-policy";
import type {
  CommandApprovalPreview,
  CommandExecutionContext,
  CommandExecutionToolResult,
  SandboxExecutionOptions,
  SandboxExecutor,
} from "./contracts";

export { CommandExecutionStoreError } from "./execution-repository";

export function enqueueApprovedCommandExecution(
  ...args: Parameters<typeof repository.enqueueApprovedCommandExecution>
) {
  return repository.enqueueApprovedCommandExecution(...args);
}

export function listCommandExecutions(
  ...args: Parameters<typeof repository.listCommandExecutions>
) {
  return repository.listCommandExecutions(...args);
}

export function getCommandExecution(
  ...args: Parameters<typeof repository.getCommandExecution>
) {
  return repository.getCommandExecution(...args);
}

export function listCommandExecutionEvents(
  ...args: Parameters<typeof repository.listCommandExecutionEvents>
) {
  return repository.listCommandExecutionEvents(...args);
}

export function requestCommandExecutionCancel(
  ...args: Parameters<typeof repository.requestCommandExecutionCancel>
) {
  return repository.requestCommandExecutionCancel(...args);
}

export function retryCommandExecution(
  ...args: Parameters<typeof repository.retryCommandExecution>
) {
  return repository.retryCommandExecution(...args);
}

export async function prepareCommandApprovalPreview(
  args: Record<string, unknown>,
  context: CommandExecutionContext,
): Promise<CommandApprovalPreview> {
  const validation = validateExecuteCommandArgs(args);
  if (!validation.ok) {
    throw new Error(validation.message);
  }

  const value = validation.value as ValidatedCommandArgs;
  await resolveSandboxExecutionRequest(value, context);
  return {
    args: value.args,
    command: value.command,
    cwd: value.cwd,
    filesystem: "read-only",
    kind: "command",
    network: "disabled",
    summary: createCommandSummary(value),
    timeoutMs: value.timeoutMs,
  };
}

export async function executeCommandInSandbox(
  args: Record<string, unknown>,
  context: CommandExecutionContext,
  executor?: SandboxExecutor,
  options?: SandboxExecutionOptions,
): Promise<CommandExecutionToolResult> {
  const validation = validateExecuteCommandArgs(args);
  if (!validation.ok) {
    return createCommandError("invalid_tool_args", validation.message);
  }

  let request;
  try {
    request = await resolveSandboxExecutionRequest(
      validation.value as ValidatedCommandArgs,
      context,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "执行路径无效。";
    return createCommandError("sandbox_path_invalid", message);
  }

  const resolvedExecutor =
    executor ??
    (await import("./sandbox-executor")).createSandboxExecutor();
  const result = await resolvedExecutor.execute(request, options);
  if (result.status === "completed") {
    return {
      commandResult: result,
      ok: true,
      summary: result.summary,
    };
  }

  return {
    commandResult: result,
    error: {
      code: `command_${result.status}`,
      message: result.summary,
    },
    ok: false,
    summary: result.summary,
  };
}

function createCommandError(
  code: string,
  message: string,
): CommandExecutionToolResult {
  return {
    error: { code, message },
    ok: false,
    summary: message,
  };
}
