import type { CommandExecutionSnapshot } from "@/lib/command-execution/contracts";
import {
  CommandExecutionStoreError,
  getCommandExecution,
  listCommandExecutions,
} from "@/lib/command-execution/execution-service";
import type { TrustedMcpThreadAccess } from "../../access/policy";
import { McpPublicError } from "../../core/errors";
import type { CommandExecutionListItem } from "./contracts";

export type CommandExecutionMcpPort = {
  getCommandExecution: typeof getCommandExecution;
  listCommandExecutions: typeof listCommandExecutions;
};

export const defaultCommandExecutionMcpPort: CommandExecutionMcpPort = {
  getCommandExecution,
  listCommandExecutions,
};

export async function listExecutionItems(
  trustedScope: TrustedMcpThreadAccess,
  limit: number,
  port: CommandExecutionMcpPort,
): Promise<CommandExecutionListItem[]> {
  const executions = await callCommandExecutionService(() =>
    port.listCommandExecutions(
      trustedScope.scope,
      trustedScope.threadId,
      limit,
    ),
  );
  return executions.map(toCommandExecutionListItem);
}

export function readExecution(
  trustedScope: TrustedMcpThreadAccess,
  executionId: string,
  port: CommandExecutionMcpPort,
): Promise<CommandExecutionSnapshot | null> {
  return callCommandExecutionService(() =>
    port.getCommandExecution(
      trustedScope.scope,
      trustedScope.threadId,
      executionId,
    ),
  );
}

async function callCommandExecutionService<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof CommandExecutionStoreError) {
      throw new McpPublicError(error.code, error.message);
    }
    throw error;
  }
}

function toCommandExecutionListItem(
  execution: CommandExecutionSnapshot,
): CommandExecutionListItem {
  return {
    args: execution.args,
    attempt: execution.attempt,
    command: execution.command,
    createdAt: execution.createdAt,
    cwd: execution.cwd,
    executionId: execution.executionId,
    finishedAt: execution.finishedAt,
    maxAttempts: execution.maxAttempts,
    outputTruncated: execution.outputTruncated,
    parentExecutionId: execution.parentExecutionId,
    rootExecutionId: execution.rootExecutionId,
    startedAt: execution.startedAt,
    status: execution.status,
    summary: execution.summary,
    toolCallId: execution.toolCallId,
    updatedAt: execution.updatedAt,
  };
}
