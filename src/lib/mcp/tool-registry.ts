import type { McpToolDefinition } from "./core/tool-definition";
import {
  createCommandExecutionMcpTools,
} from "./tools/command-execution/tools";
import type { CommandExecutionMcpPort } from "./tools/command-execution/adapter";
import {
  createFilesystemMcpTools,
} from "./tools/filesystem/tools";
import type { FilesystemMcpPort } from "./tools/filesystem/adapter";

export type DefaultMcpToolDependencies = {
  commandExecution?: CommandExecutionMcpPort;
  filesystem?: FilesystemMcpPort;
};

export function createDefaultMcpToolDefinitions(
  dependencies: DefaultMcpToolDependencies = {},
): McpToolDefinition[] {
  return [
    ...createCommandExecutionMcpTools(dependencies.commandExecution),
    ...createFilesystemMcpTools(dependencies.filesystem),
  ];
}
