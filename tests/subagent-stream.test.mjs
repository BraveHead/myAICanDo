import { describe, expect, test } from "bun:test";

const {
  applyChatStreamProjection,
  createChatStreamProjection,
} = await import("../src/lib/chat-stream-projection.ts");

describe("M8 subagent stream projection", () => {
  test("merges start and end events into one ordered lifecycle", () => {
    let projection = createChatStreamProjection();
    projection = applyChatStreamProjection(projection, {
      agent: "filesystem",
      parentAgentId: "coordinator",
      startedAt: "2026-07-15T00:00:00.000Z",
      subtaskId: "task_1",
      taskSummary: "检查 docs 目录",
      type: "subagent_start",
    });
    projection = applyChatStreamProjection(projection, {
      agent: "filesystem",
      durationMs: 240,
      finishedAt: "2026-07-15T00:00:00.240Z",
      status: "completed",
      subtaskId: "task_1",
      summary: "找到 3 个文档",
      type: "subagent_end",
    });

    expect(projection.subagents).toEqual([
      {
        agent: "filesystem",
        durationMs: 240,
        finishedAt: "2026-07-15T00:00:00.240Z",
        parentAgentId: "coordinator",
        startedAt: "2026-07-15T00:00:00.000Z",
        status: "completed",
        subtaskId: "task_1",
        summary: "找到 3 个文档",
        taskSummary: "检查 docs 目录",
      },
    ]);
  });

  test("keeps failed subagent result without throwing away the parent stream", () => {
    const projection = applyChatStreamProjection(
      createChatStreamProjection(),
      {
        agent: "weather",
        durationMs: 80,
        error: "天气服务不可用",
        finishedAt: "2026-07-15T00:00:00.080Z",
        status: "failed",
        subtaskId: "task_failed",
        summary: "子任务执行失败",
        type: "subagent_end",
      },
    );

    expect(projection.subagents[0]).toMatchObject({
      agent: "weather",
      error: "天气服务不可用",
      status: "failed",
      summary: "子任务执行失败",
      taskSummary: "子任务",
    });
  });
});
