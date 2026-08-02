import { describe, expect, test } from "bun:test";
import {
  Client,
  InMemoryTransport,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import {
  mcpThreadScopeInputSchema,
  withMcpToolErrorSchema,
} from "../src/lib/mcp/contracts/common.ts";
import { McpPublicError } from "../src/lib/mcp/core/errors.ts";
import {
  defineMcpTool,
  readonlyToolAnnotations,
} from "../src/lib/mcp/core/tool-definition.ts";
import {
  createMcpServer,
  McpServerDefinitionError,
} from "../src/lib/mcp/server-factory.ts";
import {
  createDefaultMcpToolDefinitions,
} from "../src/lib/mcp/tool-registry.ts";

const config = {
  identity: {
    tenantHashId: "tenant_core",
    userHashId: "user_core",
  },
  metadata: {
    instructions: "MCP core test",
    name: "my-ai-can-do-mcp",
    title: "MCP core test",
    version: "0.1.0-test",
  },
};

const dummyInputSchema = mcpThreadScopeInputSchema
  .extend({
    value: z.string(),
  })
  .strict();

const dummyOutputSchema = withMcpToolErrorSchema(
  z
    .object({
      ok: z.literal(true),
      value: z.string(),
    })
    .strict(),
);

describe("MCP Core", () => {
  test("可通过静态定义注册虚拟第五个工具，无需修改 Server Factory", async () => {
    const tools = [
      ...createDefaultMcpToolDefinitions(),
      createDummyTool("echo_fixture", async (input) => ({
        ok: true,
        value: input.value,
      })),
    ];

    await withCoreClient(tools, async (client) => {
      const discovered = await client.listTools();
      expect(discovered.tools.map((tool) => tool.name)).toEqual([
        "list_command_executions",
        "get_command_execution",
        "list_workspace_files",
        "read_workspace_file",
        "echo_fixture",
      ]);

      const result = await client.callTool({
        arguments: {
          threadId: "thread_core",
          value: "第五个工具",
          workspaceId: "workspace_core",
        },
        name: "echo_fixture",
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({
        ok: true,
        value: "第五个工具",
      });
    });
  });

  test("启动时拒绝重复工具名称", () => {
    const tool = createDummyTool("duplicate_tool", async () => ({
      ok: true,
      value: "duplicate",
    }));

    expect(() =>
      createMcpServer(config, {
        accessPolicy: createAccessPolicy(),
        tools: [tool, tool],
      }),
    ).toThrow(McpServerDefinitionError);
    expect(() =>
      createMcpServer(config, {
        accessPolicy: createAccessPolicy(),
        tools: [tool, tool],
      }),
    ).toThrow("MCP 工具名称重复：duplicate_tool。");
  });

  test("统一处理公开错误和未知异常，并记录调用与内部错误", async () => {
    const invocationLogs = [];
    const internalErrorLogs = [];
    const logger = {
      logInternalError(input) {
        internalErrorLogs.push(input);
      },
      logInvocation(input) {
        invocationLogs.push(input);
      },
    };
    const tools = [
      createDummyTool("public_error_fixture", async () => {
        throw new McpPublicError("fixture_denied", "测试公开错误。");
      }),
      createDummyTool("internal_error_fixture", async () => {
        throw new Error("不应返回给客户端的内部细节");
      }),
    ];

    await withCoreClient(
      tools,
      async (client) => {
        const publicResult = await callFixtureTool(
          client,
          "public_error_fixture",
        );
        expect(publicResult.isError).toBe(true);
        expect(publicResult.structuredContent).toMatchObject({
          error: {
            code: "fixture_denied",
            message: "测试公开错误。",
          },
          ok: false,
        });

        const internalResult = await callFixtureTool(
          client,
          "internal_error_fixture",
        );
        expect(internalResult.isError).toBe(true);
        expect(internalResult.structuredContent).toMatchObject({
          error: {
            code: "internal_error",
            message:
              "MCP 工具执行失败，请根据 requestId 查看服务端日志。",
          },
          ok: false,
        });
        expect(internalResult.content[0].text).not.toContain(
          "不应返回给客户端的内部细节",
        );
      },
      logger,
    );

    expect(invocationLogs).toHaveLength(2);
    expect(invocationLogs.every((log) => log.isError)).toBe(true);
    expect(internalErrorLogs).toHaveLength(1);
    expect(internalErrorLogs[0]).toMatchObject({
      toolName: "internal_error_fixture",
    });
  });
});

function createDummyTool(name, execute) {
  return defineMcpTool({
    access: { kind: "thread" },
    annotations: {
      ...readonlyToolAnnotations,
      title: name,
    },
    description: `${name} 测试工具`,
    execute,
    inputSchema: dummyInputSchema,
    name,
    outputSchema: dummyOutputSchema,
    title: name,
  });
}

function createAccessPolicy() {
  return {
    async requireThreadAccess(input) {
      return {
        scope: {
          tenantHashId: input.tenantHashId,
          userHashId: input.userHashId,
          workspaceId: input.workspaceId,
        },
        threadId: input.threadId,
      };
    },
  };
}

async function callFixtureTool(client, name) {
  return client.callTool({
    arguments: {
      threadId: "thread_core",
      value: "fixture",
      workspaceId: "workspace_core",
    },
    name,
  });
}

async function withCoreClient(
  tools,
  operation,
  logger = {
    logInternalError() {},
    logInvocation() {},
  },
) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createMcpServer(config, {
    accessPolicy: createAccessPolicy(),
    logger,
    tools,
  });
  const client = new Client({
    name: "mcp-core-test-client",
    version: "0.1.0",
  });

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    return await operation(client);
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}
