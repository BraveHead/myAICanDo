import packageMetadata from "../../../package.json";

export const MCP_SERVER_NAME = "my-ai-can-do-mcp";

export type McpServerIdentity = {
  tenantHashId: string;
  userHashId: string;
};

export type McpServerMetadata = {
  instructions: string;
  name: typeof MCP_SERVER_NAME;
  title: string;
  version: string;
};

export type McpServerConfig = {
  identity: McpServerIdentity;
  metadata: McpServerMetadata;
};

export type McpStdioConfig = McpServerConfig & {
  databaseUrl: string;
};

export type McpServerEnvironment = Readonly<
  Record<string, string | undefined>
>;

export class McpConfigError extends Error {
  constructor(
    message: string,
    readonly code = "mcp_config_invalid",
  ) {
    super(message);
    this.name = "McpConfigError";
  }
}

export function loadMcpServerConfig(
  environment: McpServerEnvironment = process.env,
): McpStdioConfig {
  return {
    databaseUrl: readRequiredEnvironmentValue(environment, "DATABASE_URL"),
    identity: {
      tenantHashId: readRequiredEnvironmentValue(
        environment,
        "MCP_TENANT_HASH_ID",
      ),
      userHashId: readRequiredEnvironmentValue(
        environment,
        "MCP_USER_HASH_ID",
      ),
    },
    metadata: {
      instructions:
        "只提供当前租户用户已授权线程内的命令执行查询和文件读取能力。所有工具都需要 workspaceId 与 threadId，且不会修改数据。",
      name: MCP_SERVER_NAME,
      title: "myAICanDo 只读 MCP Server",
      version: packageMetadata.version,
    },
  };
}

function readRequiredEnvironmentValue(
  environment: McpServerEnvironment,
  name: "DATABASE_URL" | "MCP_TENANT_HASH_ID" | "MCP_USER_HASH_ID",
) {
  const value = environment[name]?.trim();
  if (!value) {
    throw new McpConfigError(`缺少必填环境变量 ${name}。`);
  }
  return value;
}
