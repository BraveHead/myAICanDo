import { describe, expect, test } from "bun:test";
import {
  CommandExecutionStoreError,
} from "../src/lib/command-execution/execution-service.ts";
import { McpPublicError } from "../src/lib/mcp/core/errors.ts";
import {
  createCommandExecutionMcpTools,
} from "../src/lib/mcp/tools/command-execution/tools.ts";
import {
  createFilesystemMcpTools,
} from "../src/lib/mcp/tools/filesystem/tools.ts";

const trustedScope = {
  scope: {
    tenantHashId: "tenant_tools",
    userHashId: "user_tools",
    workspaceId: "workspace_tools",
  },
  threadId: "thread_tools",
};

const executionListProjectionSource = {
  args: ["--version"],
  attempt: 1,
  command: "bun",
  createdAt: "2026-08-01T00:00:00.000Z",
  cwd: "workspace",
  executionId: "execution_tools",
  finishedAt: null,
  maxAttempts: 3,
  outputTruncated: false,
  parentExecutionId: null,
  rootExecutionId: "execution_tools",
  startedAt: null,
  status: "queued",
  summary: "等待执行",
  toolCallId: "tool_call_tools",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

describe("MCP command-execution 工具模块", () => {
  test("列表工具只通过领域 Port 查询并投影轻量字段", async () => {
    const calls = [];
    const tools = createCommandExecutionMcpTools({
      async getCommandExecution() {
        return null;
      },
      async listCommandExecutions(scope, threadId, limit) {
        calls.push({ limit, scope, threadId });
        return [
          {
            ...executionListProjectionSource,
            stderr: "不应进入列表",
            stdout: "不应进入列表",
          },
        ];
      },
    });
    const tool = tools.find(
      (definition) => definition.name === "list_command_executions",
    );

    const result = await tool.execute(
      {
        limit: 12,
        threadId: trustedScope.threadId,
        workspaceId: trustedScope.scope.workspaceId,
      },
      { requestId: "request_tools", trustedScope },
    );

    expect(result.executions[0]).not.toHaveProperty("stdout");
    expect(result.executions[0]).not.toHaveProperty("stderr");
    expect(calls).toEqual([
      {
        limit: 12,
        scope: trustedScope.scope,
        threadId: trustedScope.threadId,
      },
    ]);
  });

  test("领域存储异常在工具模块边界转换为公开错误", async () => {
    const tools = createCommandExecutionMcpTools({
      async getCommandExecution() {
        throw new CommandExecutionStoreError(
          "execution_store_unavailable",
          "执行存储不可用。",
          500,
        );
      },
      async listCommandExecutions() {
        return [];
      },
    });
    const tool = tools.find(
      (definition) => definition.name === "get_command_execution",
    );

    await expect(
      tool.execute(
        {
          executionId: "execution_tools",
          threadId: trustedScope.threadId,
          workspaceId: trustedScope.scope.workspaceId,
        },
        { requestId: "request_tools", trustedScope },
      ),
    ).rejects.toMatchObject({
      code: "execution_store_unavailable",
      message: "执行存储不可用。",
      name: "McpPublicError",
    });
  });
});

describe("MCP filesystem 工具模块", () => {
  test("只在适配器中构造线程文件上下文", async () => {
    const calls = [];
    const tools = createFilesystemMcpTools({
      async listFilesystemDirectory(context, path) {
        calls.push({ context, path });
        return {
          entries: [],
          ok: true,
          path,
          summary: "目录为空。",
          truncated: false,
        };
      },
      async readFilesystemFile() {
        return {
          content: "fixture",
          ok: true,
          path: "workspace/a.txt",
          sizeBytes: 7,
          summary: "已读取文件。",
        };
      },
    });
    const tool = tools.find(
      (definition) => definition.name === "list_workspace_files",
    );

    await tool.execute(
      {
        path: "workspace",
        threadId: trustedScope.threadId,
        workspaceId: trustedScope.scope.workspaceId,
      },
      { requestId: "request_tools", trustedScope },
    );

    expect(calls).toEqual([
      {
        context: {
          threadId: trustedScope.threadId,
          threadScope: trustedScope.scope,
        },
        path: "workspace",
      },
    ]);
  });

  test("文件服务错误在领域模块中转换为公开错误", async () => {
    const tools = createFilesystemMcpTools({
      async listFilesystemDirectory() {
        return {
          entries: [],
          ok: true,
          path: ".",
          summary: "目录为空。",
          truncated: false,
        };
      },
      async readFilesystemFile() {
        return {
          error: {
            code: "file_not_found",
            message: "文件不存在。",
          },
          ok: false,
        };
      },
    });
    const tool = tools.find(
      (definition) => definition.name === "read_workspace_file",
    );

    await expect(
      tool.execute(
        {
          path: "workspace/missing.txt",
          threadId: trustedScope.threadId,
          workspaceId: trustedScope.scope.workspaceId,
        },
        { requestId: "request_tools", trustedScope },
      ),
    ).rejects.toBeInstanceOf(McpPublicError);
  });
});
