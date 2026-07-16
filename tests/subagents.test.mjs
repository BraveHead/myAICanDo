import { describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";

mock.module("server-only", () => ({}));

const {
  createSubagentThreadId,
  getReadonlySubagentDefinition,
  isSubagentId,
  runSubagentTaskTool,
} = await import("../src/lib/agent/harness/subagents/index.ts");
const { createHarnessedAgent } = await import(
  "../src/lib/agent/harness/agent-harness.ts"
);

const scope = {
  tenantHashId: "tenant_1",
  userHashId: "user_1",
};

describe("M4 subagents", () => {
  test("task returns missing_thread_context when scope is absent", async () => {
    const result = await runSubagentTaskTool(
      {
        agent: "memory",
        task: "查询当前用户偏好",
      },
      {
        apiKey: "test-key",
        modelName: "test-model",
        runSubagent: async () => {
          throw new Error("runSubagent should not be called");
        },
      },
      {
        toolCallId: "call_missing_context",
      },
    );

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("missing_thread_context");
    expect(result.subtaskId).toBe("task_call_missing_context");
  });

  test("subagent registry only allows filesystem, memory, and weather", () => {
    expect(isSubagentId("filesystem")).toBe(true);
    expect(isSubagentId("memory")).toBe(true);
    expect(isSubagentId("weather")).toBe(true);
    expect(isSubagentId("demo")).toBe(false);
  });

  test("child thread id uses parent thread, subtask id, and subagent id", () => {
    expect(createSubagentThreadId("thread_1", "task_call_1", "filesystem")).toBe(
      "thread_1:subtask:task_call_1:filesystem",
    );
  });

  test("readonly filesystem and memory subagents do not expose mutation tools", () => {
    const filesystemTools = getToolNames(
      getReadonlySubagentDefinition("filesystem").tools({
        threadId: "thread_1",
        threadScope: scope,
      }),
    );
    const memoryTools = getToolNames(
      getReadonlySubagentDefinition("memory").tools({
        threadId: "thread_1",
        threadScope: scope,
      }),
    );

    expect(filesystemTools).toContain("list_filesystem_directory");
    expect(filesystemTools).toContain("read_filesystem_file");
    expect(filesystemTools).toContain("search_filesystem_text");
    expect(filesystemTools).toContain("glob_files");
    expect(filesystemTools).not.toContain("write_file");
    expect(filesystemTools).not.toContain("edit_file");
    expect(filesystemTools).not.toContain("delete_file");

    expect(memoryTools).toEqual(["list_memories"]);
  });

  test("task tool returns only the subagent final report envelope", async () => {
    const result = await runSubagentTaskTool(
      {
        agent: "filesystem",
        context: "只关注 workspace/report.md",
        task: "读取并总结报告",
      },
      {
        apiKey: "test-key",
        modelName: "test-model",
        runSubagent: async ({ childThreadId, subtaskId }) => ({
          agent: "filesystem",
          childThreadId,
          ok: true,
          subtaskId,
          summary: "报告指出本周任务已完成。",
          toolResults: [
            {
              summary: "读取 workspace/report.md 成功。",
              toolName: "read_filesystem_file",
            },
          ],
        }),
        threadId: "thread_parent",
        threadScope: scope,
      },
      {
        toolCallId: "call_summary",
      },
    );

    expect(result).toEqual({
      agent: "filesystem",
      childThreadId: "thread_parent:subtask:task_call_summary:filesystem",
      ok: true,
      subtaskId: "task_call_summary",
      summary: "报告指出本周任务已完成。",
      toolResults: [
        {
          summary: "读取 workspace/report.md 成功。",
          toolName: "read_filesystem_file",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("messages");
  });

  test("coordinator prompt prefers task for compound delegation", async () => {
    const source = await fs.readFile(
      path.join(
        import.meta.dir,
        "../src/lib/agent/definitions/coordinator.ts",
      ),
      "utf8",
    );

    expect(source).toContain("task");
    expect(source).toContain("优先调用 task");
    expect(source).toContain("final report");
  });

  test("subagent runner disables planning tools for child agents", async () => {
    const source = await fs.readFile(
      path.join(import.meta.dir, "../src/lib/agent/core/agent-runner.ts"),
      "utf8",
    );

    expect(source).toContain("planningEnabled: false");
  });

  test("harness can omit planning tool injection for readonly subagents", async () => {
    const agent = await createHarnessedAgent({
      apiKey: "test-key",
      createMiddleware: () => [],
      definition: getReadonlySubagentDefinition("filesystem"),
      getCheckpointer: async () => false,
      getCheckpointerType: () => "none",
      modelName: "test-model",
      planningEnabled: false,
      threadId: "thread_1",
      threadScope: scope,
    });

    expect(getToolNames(agent.options.tools)).toEqual([
      "glob_files",
      "list_filesystem_directory",
      "read_filesystem_file",
      "search_filesystem_text",
    ]);
    expect(agent.options.systemPrompt).not.toContain("write_todos");
  });
});

function getToolNames(tools) {
  return tools.map((tool) => tool.name).sort();
}
