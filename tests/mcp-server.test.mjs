import { describe, expect, test } from "bun:test";
import {
  Client,
  InMemoryTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  listFilesystemDirectory,
  readFilesystemFile,
} from "../src/lib/agent/services/filesystem-service.ts";
import { createDefaultMcpServer } from "../src/lib/mcp/default-server.ts";

const config = {
  identity: {
    tenantHashId: "tenant_from_environment",
    userHashId: "user_from_environment",
  },
  metadata: {
    instructions: "MCP test server",
    name: "my-ai-can-do-mcp",
    title: "MCP test server",
    version: "0.1.0",
  },
};

const trustedScope = {
  scope: {
    tenantHashId: config.identity.tenantHashId,
    userHashId: config.identity.userHashId,
    workspaceId: "workspace_1",
  },
  threadId: "thread_1",
};

const executionSnapshot = {
  agentId: "coordinator",
  approvalId: "approval_1",
  args: ["--version"],
  attempt: 1,
  backend: "mock",
  cancelRequestedAt: null,
  command: "node",
  createdAt: "2026-07-31T00:00:00.000Z",
  cwd: "workspace",
  executionId: "execution_1",
  failureCode: undefined,
  finishedAt: "2026-07-31T00:00:01.000Z",
  lastEventId: "12",
  leaseExpiresAt: null,
  maxAttempts: 3,
  outputTruncated: false,
  parentExecutionId: null,
  result: {
    args: ["--version"],
    backend: "mock",
    command: "node",
    cwd: "workspace",
    durationMs: 1000,
    executionId: "execution_1",
    exitCode: 0,
    finishedAt: "2026-07-31T00:00:01.000Z",
    outputTruncated: false,
    status: "completed",
    stderr: "完整 stderr",
    stdout: "完整 stdout",
    summary: "执行完成",
  },
  rootExecutionId: "execution_1",
  startedAt: "2026-07-31T00:00:00.000Z",
  status: "completed",
  stderr: "完整 stderr",
  stdout: "完整 stdout",
  summary: "执行完成",
  threadId: "thread_1",
  timeoutMs: 30_000,
  toolCallId: "tool_call_1",
  updatedAt: "2026-07-31T00:00:01.000Z",
  workspaceId: "workspace_1",
};

describe("M11 MCP Server", () => {
  test("只发现四个只读工具，且输入中不暴露 tenant/user", async () => {
    await withMcpClient({}, async ({ client }) => {
      const { tools } = await client.listTools();

      expect(tools.map((tool) => tool.name)).toEqual([
        "list_command_executions",
        "get_command_execution",
        "list_workspace_files",
        "read_workspace_file",
      ]);
      expect(tools).toHaveLength(4);

      for (const tool of tools) {
        expect(tool.annotations).toMatchObject({
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
          readOnlyHint: true,
        });
        expect(tool.inputSchema.properties).not.toHaveProperty(
          "tenantHashId",
        );
        expect(tool.inputSchema.properties).not.toHaveProperty("userHashId");
        expect(tool.inputSchema.additionalProperties).toBe(false);
      }
    });
  });

  test("list 默认传入 limit=20，并且仅返回轻量任务字段", async () => {
    const serviceCalls = [];
    const accessCalls = [];

    await withMcpClient(
      {
        accessPolicy: {
          async requireThreadAccess(input) {
            accessCalls.push(input);
            return trustedScope;
          },
        },
        services: createServices({
          async listCommandExecutions(scope, threadId, limit) {
            serviceCalls.push({ limit, scope, threadId });
            return [executionSnapshot];
          },
        }),
      },
      async ({ client }) => {
        const result = await client.callTool({
          arguments: {
            threadId: "thread_1",
            workspaceId: "workspace_1",
          },
          name: "list_command_executions",
        });

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent.count).toBe(1);
        expect(result.structuredContent.executions).toHaveLength(1);
        const item = result.structuredContent.executions[0];
        expect(item).toMatchObject({
          executionId: "execution_1",
          outputTruncated: false,
          status: "completed",
          summary: "执行完成",
        });
        expect(item).not.toHaveProperty("stdout");
        expect(item).not.toHaveProperty("stderr");
        expect(item).not.toHaveProperty("result");
      },
    );

    expect(serviceCalls).toEqual([
      {
        limit: 20,
        scope: trustedScope.scope,
        threadId: "thread_1",
      },
    ]);
    expect(accessCalls).toEqual([
      {
        tenantHashId: config.identity.tenantHashId,
        threadId: "thread_1",
        userHashId: config.identity.userHashId,
        workspaceId: "workspace_1",
      },
    ]);
  });

  test("get 返回包含 stdout、stderr 和 result 的完整任务快照", async () => {
    const serviceCalls = [];

    await withMcpClient(
      {
        services: createServices({
          async getCommandExecution(scope, threadId, executionId) {
            serviceCalls.push({ executionId, scope, threadId });
            return executionSnapshot;
          },
        }),
      },
      async ({ client }) => {
        const result = await client.callTool({
          arguments: {
            executionId: "execution_1",
            threadId: "thread_1",
            workspaceId: "workspace_1",
          },
          name: "get_command_execution",
        });

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent.execution).toMatchObject({
          executionId: "execution_1",
          result: {
            stderr: "完整 stderr",
            stdout: "完整 stdout",
          },
          stderr: "完整 stderr",
          stdout: "完整 stdout",
        });
        expect(JSON.parse(result.content[0].text)).toEqual(
          result.structuredContent,
        );
      },
    );

    expect(serviceCalls).toEqual([
      {
        executionId: "execution_1",
        scope: trustedScope.scope,
        threadId: "thread_1",
      },
    ]);
  });

  test("文件服务错误统一为带 requestId 的 MCP 工具错误", async () => {
    await withMcpClient(
      {
        services: createServices({
          async readFilesystemFile() {
            return {
              error: {
                code: "file_not_found",
                message: "文件不存在。",
              },
              ok: false,
            };
          },
        }),
      },
      async ({ client }) => {
        const result = await client.callTool({
          arguments: {
            path: "workspace/missing.txt",
            threadId: "thread_1",
            workspaceId: "workspace_1",
          },
          name: "read_workspace_file",
        });

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: {
            code: "file_not_found",
            message: "文件不存在。",
          },
          ok: false,
        });
        expect(result.structuredContent.error.requestId).toMatch(
          /^[0-9a-f-]{36}$/i,
        );
        expect(JSON.parse(result.content[0].text)).toEqual(
          result.structuredContent,
        );
      },
    );
  });

  test("通过 MCP 复用真实文件服务并保留沙盒读取边界", async () => {
    const previousSandboxRoot = process.env.FILESYSTEM_SANDBOX_ROOT;
    const sandboxRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "m11-mcp-filesystem-"),
    );
    const threadRoot = path.join(
      sandboxRoot,
      config.identity.tenantHashId,
      config.identity.userHashId,
      trustedScope.threadId,
    );
    const workspaceRoot = path.join(threadRoot, "workspace");

    process.env.FILESYSTEM_SANDBOX_ROOT = sandboxRoot;
    try {
      await fs.mkdir(workspaceRoot, { recursive: true });
      await fs.writeFile(
        path.join(workspaceRoot, "readable.txt"),
        "MCP filesystem boundary",
        "utf8",
      );
      await fs.writeFile(
        path.join(workspaceRoot, "binary.bin"),
        Buffer.from([0, 1, 2, 3]),
      );
      await fs.writeFile(
        path.join(workspaceRoot, "too-large.txt"),
        Buffer.alloc(256_001, 97),
      );
      await fs.symlink(
        path.join(workspaceRoot, "readable.txt"),
        path.join(workspaceRoot, "readable-link.txt"),
      );

      await withMcpClient(
        {
          services: createServices({
            listFilesystemDirectory,
            readFilesystemFile,
          }),
        },
        async ({ client }) => {
          const listed = await client.callTool({
            arguments: {
              path: "workspace",
              threadId: trustedScope.threadId,
              workspaceId: trustedScope.scope.workspaceId,
            },
            name: "list_workspace_files",
          });
          expect(listed.isError).not.toBe(true);
          expect(listed.structuredContent.entries).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                name: "readable.txt",
                type: "file",
              }),
              expect.objectContaining({
                name: "readable-link.txt",
                type: "symlink",
              }),
            ]),
          );

          const readable = await client.callTool({
            arguments: {
              path: "workspace/readable.txt",
              threadId: trustedScope.threadId,
              workspaceId: trustedScope.scope.workspaceId,
            },
            name: "read_workspace_file",
          });
          expect(readable.isError).not.toBe(true);
          expect(readable.structuredContent).toMatchObject({
            content: "MCP filesystem boundary",
            ok: true,
            path: "workspace/readable.txt",
          });

          const cases = [
            {
              code: "invalid_path",
              name: "list_workspace_files",
              path: "../outside",
            },
            {
              code: "invalid_path",
              name: "read_workspace_file",
              path: "../outside.txt",
            },
            {
              code: "symlink_not_allowed",
              name: "read_workspace_file",
              path: "workspace/readable-link.txt",
            },
            {
              code: "binary_file",
              name: "read_workspace_file",
              path: "workspace/binary.bin",
            },
            {
              code: "file_too_large",
              name: "read_workspace_file",
              path: "workspace/too-large.txt",
            },
          ];

          for (const testCase of cases) {
            const result = await client.callTool({
              arguments: {
                path: testCase.path,
                threadId: trustedScope.threadId,
                workspaceId: trustedScope.scope.workspaceId,
              },
              name: testCase.name,
            });
            expectMcpToolError(result, testCase.code);
          }
        },
      );
    } finally {
      if (previousSandboxRoot === undefined) {
        delete process.env.FILESYSTEM_SANDBOX_ROOT;
      } else {
        process.env.FILESYSTEM_SANDBOX_ROOT = previousSandboxRoot;
      }
      await fs.rm(sandboxRoot, {
        force: true,
        recursive: true,
      });
    }
  });

  test("严格输入 Schema 拒绝调用方注入 tenant/user", async () => {
    const accessCalls = [];

    await withMcpClient(
      {
        accessPolicy: {
          async requireThreadAccess(input) {
            accessCalls.push(input);
            return trustedScope;
          },
        },
      },
      async ({ client }) => {
        const result = await client.callTool({
          arguments: {
            tenantHashId: "tenant_attacker",
            threadId: "thread_1",
            userHashId: "user_attacker",
            workspaceId: "workspace_1",
          },
          name: "list_command_executions",
        });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("tenantHashId");
        expect(result.content[0].text).toContain("userHashId");
      },
    );

    expect(accessCalls).toHaveLength(0);
  });
});

describe("M11 MCP stdio", () => {
  test(
    "子进程可完成握手和工具发现，启动日志只出现在 stderr，关闭后进程退出",
    async () => {
      const transportErrors = [];
      let stderr = "";
      const transport = new StdioClientTransport({
        args: ["tests/fixtures/mcp-stdio-fixture.ts"],
        command: process.execPath,
        cwd: process.cwd(),
        env: {
          PATH: process.env.PATH ?? "",
        },
        stderr: "pipe",
      });
      transport.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      const client = new Client({
        name: "m11-stdio-test-client",
        version: "0.1.0",
      });
      client.onerror = (error) => {
        transportErrors.push(error);
      };

      await client.connect(transport);
      expect(transport.pid).not.toBeNull();
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual([
        "list_command_executions",
        "get_command_execution",
        "list_workspace_files",
        "read_workspace_file",
      ]);
      expect(transportErrors).toEqual([]);
      expect(stderr).toContain('"message":"MCP stdio fixture started"');

      await client.close();
      expect(transport.pid).toBeNull();
    },
    10_000,
  );
});

function createServices(overrides = {}) {
  return {
    async getCommandExecution() {
      return executionSnapshot;
    },
    async listCommandExecutions() {
      return [executionSnapshot];
    },
    async listFilesystemDirectory(_context, path) {
      return {
        entries: [],
        ok: true,
        path,
        summary: "目录为空。",
        truncated: false,
      };
    },
    async readFilesystemFile(_context, path) {
      return {
        content: "fixture",
        ok: true,
        path,
        sizeBytes: 7,
        summary: "已读取文件。",
      };
    },
    ...overrides,
  };
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

async function withMcpClient(dependencies, operation) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const services = dependencies.services ?? createServices();
  const server = createDefaultMcpServer(config, {
    accessPolicy: dependencies.accessPolicy ?? createAccessPolicy(),
    commandExecution: {
      getCommandExecution: services.getCommandExecution,
      listCommandExecutions: services.listCommandExecutions,
    },
    filesystem: {
      listFilesystemDirectory: services.listFilesystemDirectory,
      readFilesystemFile: services.readFilesystemFile,
    },
  });
  const client = new Client({
    name: "m11-in-memory-test-client",
    version: "0.1.0",
  });

  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  try {
    return await operation({ client, server });
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

function expectMcpToolError(result, code) {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    error: { code },
    ok: false,
  });
  expect(result.structuredContent.error.requestId).toMatch(
    /^[0-9a-f-]{36}$/i,
  );
  expect(JSON.parse(result.content[0].text)).toEqual(
    result.structuredContent,
  );
}
