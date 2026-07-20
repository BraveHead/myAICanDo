import { describe, expect, test } from "bun:test";

const {
  applyChatStreamProjection,
  createChatStreamProjection,
  dedupeFilesystemChanges,
} = await import("../src/lib/chat-stream-projection.ts");

describe("M8 runtime stream projection", () => {
  test("deduplicates filesystem changes and keeps mixed event order", () => {
    let projection = createChatStreamProjection();
    const events = [
      {
        agent: "memory",
        parentAgentId: "coordinator",
        startedAt: "2026-07-15T00:00:00.000Z",
        subtaskId: "task_memory",
        taskSummary: "读取用户记忆",
        type: "subagent_start",
      },
      {
        changeId: "change_1",
        operation: "create",
        path: "workspace/a.md",
        status: "completed",
        summary: "已创建",
        type: "filesystem_change",
      },
      {
        changeId: "change_1",
        operation: "create",
        path: "workspace/a.md",
        status: "completed",
        summary: "已创建（缓存结果）",
        type: "filesystem_change",
      },
      {
        agent: "memory",
        durationMs: 40,
        finishedAt: "2026-07-15T00:00:00.040Z",
        status: "completed",
        subtaskId: "task_memory",
        summary: "已读取 2 条记忆",
        type: "subagent_end",
      },
    ];

    for (const event of events) {
      projection = applyChatStreamProjection(projection, event);
    }

    expect(projection.filesystemChanges).toHaveLength(1);
    expect(projection.filesystemChanges[0].summary).toBe("已创建（缓存结果）");
    expect(projection.subagents).toHaveLength(1);
    expect(projection.subagents[0].status).toBe("completed");
  });

  test("deduplicates cached approval results across runtime calls", () => {
    const emittedChangeIds = new Set();
    const change = {
      changeId: "approval:1",
      operation: "create",
      path: "workspace/a.md",
      status: "completed",
      summary: "已创建",
      type: "filesystem_change",
    };

    expect(dedupeFilesystemChanges([change], emittedChangeIds)).toEqual([change]);
    expect(dedupeFilesystemChanges([{ ...change }], emittedChangeIds)).toEqual([]);
  });
});
