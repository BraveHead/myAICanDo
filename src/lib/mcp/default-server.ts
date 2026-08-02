import {
  createMcpAccessPolicy,
  type McpAccessPolicy,
} from "./access/policy";
import type { McpServerConfig } from "./config";
import type { McpLogger } from "./core/observability";
import { createMcpServer } from "./server-factory";
import type { CommandExecutionMcpPort } from "./tools/command-execution/adapter";
import type { FilesystemMcpPort } from "./tools/filesystem/adapter";
import { createDefaultMcpToolDefinitions } from "./tool-registry";

export type DefaultMcpServerDependencies = {
  accessPolicy?: McpAccessPolicy;
  commandExecution?: CommandExecutionMcpPort;
  filesystem?: FilesystemMcpPort;
  logger?: McpLogger;
};

export function createDefaultMcpServer(
  config: McpServerConfig,
  dependencies: DefaultMcpServerDependencies = {},
) {
  return createMcpServer(config, {
    accessPolicy: dependencies.accessPolicy ?? createMcpAccessPolicy(),
    logger: dependencies.logger,
    tools: createDefaultMcpToolDefinitions({
      commandExecution: dependencies.commandExecution,
      filesystem: dependencies.filesystem,
    }),
  });
}
