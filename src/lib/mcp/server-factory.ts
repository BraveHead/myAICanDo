import { McpServer } from "@modelcontextprotocol/server";
import type { McpAccessPolicy } from "./access/policy";
import type { McpServerConfig } from "./config";
import {
  defaultMcpLogger,
  type McpLogger,
} from "./core/observability";
import type { McpToolDefinition } from "./core/tool-definition";
import { executeMcpTool } from "./core/tool-runner";

export class McpServerDefinitionError extends Error {
  constructor(
    message: string,
    readonly code = "mcp_tool_definition_invalid",
  ) {
    super(message);
    this.name = "McpServerDefinitionError";
  }
}

export type McpServerDependencies = {
  accessPolicy: McpAccessPolicy;
  logger?: McpLogger;
  tools: readonly McpToolDefinition[];
};

export function createMcpServer(
  config: McpServerConfig,
  dependencies: McpServerDependencies,
) {
  assertUniqueToolNames(dependencies.tools);

  const server = new McpServer(
    {
      name: config.metadata.name,
      title: config.metadata.title,
      version: config.metadata.version,
    },
    {
      instructions: config.metadata.instructions,
    },
  );
  const runtime = {
    accessPolicy: dependencies.accessPolicy,
    identity: config.identity,
    logger: dependencies.logger ?? defaultMcpLogger,
  };

  for (const definition of dependencies.tools) {
    server.registerTool(
      definition.name,
      {
        annotations: definition.annotations,
        description: definition.description,
        inputSchema: definition.inputSchema,
        outputSchema: definition.outputSchema,
        title: definition.title,
      },
      (input) => executeMcpTool(definition, input, runtime),
    );
  }

  return server;
}

function assertUniqueToolNames(tools: readonly McpToolDefinition[]) {
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) {
      throw new McpServerDefinitionError(
        `MCP 工具名称重复：${tool.name}。`,
      );
    }
    names.add(tool.name);
  }
}
