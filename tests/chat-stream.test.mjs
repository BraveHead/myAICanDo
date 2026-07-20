import { describe, expect, test } from "bun:test";
import {
  encodeChatSseEvent,
  isChatStreamEvent,
} from "../src/lib/chat-stream.ts";

describe("chat stream events", () => {
  test("encodes and recognizes todo_update events", () => {
    const event = {
      agentId: "filesystem",
      revision: 3,
      todos: [
        {
          content: "分析文件",
          id: "todo_1",
          status: "completed",
        },
      ],
      type: "todo_update",
      updatedAt: "2026-07-15T00:00:00.000Z",
    };

    expect(isChatStreamEvent(event, "todo_update")).toBe(true);
    expect(isChatStreamEvent(event, "tool_call")).toBe(false);

    const encoded = encodeChatSseEvent(event);
    expect(encoded).toContain("event: todo_update");
    expect(encoded).toContain('"type":"todo_update"');
    expect(encoded).toContain('"revision":3');
  });

  test("encodes and recognizes agent_retry events", () => {
    const event = {
      attempt: 1,
      completedToolCallCount: 1,
      lastToolCall: {
        toolCallId: "call_1",
        toolName: "read_filesystem_file",
      },
      maxAttempts: 1,
      reason: "Cannot read properties of undefined (reading 'message')",
      recovery: "checkpoint",
      type: "agent_retry",
    };

    expect(isChatStreamEvent(event, "agent_retry")).toBe(true);
    expect(isChatStreamEvent(event, "tool_call")).toBe(false);

    const encoded = encodeChatSseEvent(event);
    expect(encoded).toContain("event: agent_retry");
    expect(encoded).toContain('"type":"agent_retry"');
    expect(encoded).toContain('"recovery":"checkpoint"');
    expect(encoded).toContain('"reason":"Cannot read properties');
  });

  test("encodes and validates M8 lifecycle and filesystem events", () => {
    const events = [
      {
        agent: "filesystem",
        parentAgentId: "coordinator",
        startedAt: "2026-07-15T00:00:00.000Z",
        subtaskId: "task_1",
        taskSummary: "读取项目文件",
        type: "subagent_start",
      },
      {
        agent: "filesystem",
        durationMs: 120,
        finishedAt: "2026-07-15T00:00:00.120Z",
        status: "completed",
        subtaskId: "task_1",
        summary: "已完成读取",
        type: "subagent_end",
      },
      {
        changeId: "change_1",
        operation: "create",
        path: "workspace/report.md",
        sizeBytes: 148,
        status: "completed",
        summary: "已创建文件",
        type: "filesystem_change",
      },
    ];

    for (const event of events) {
      expect(isChatStreamEvent(event, event.type)).toBe(true);
      expect(encodeChatSseEvent(event)).toContain(`event: ${event.type}`);
    }

    expect(
      isChatStreamEvent(
        { type: "filesystem_change", changeId: "change_1" },
        "filesystem_change",
      ),
    ).toBe(false);
    expect(
      isChatStreamEvent(
        {
          agent: "filesystem",
          durationMs: "120",
          finishedAt: "2026-07-15T00:00:00.120Z",
          status: "completed",
          subtaskId: "task_1",
          summary: "bad",
          type: "subagent_end",
        },
        "subagent_end",
      ),
    ).toBe(false);
    expect(
      isChatStreamEvent(
        {
          status: "done",
          toolCallId: "call_1",
          toolName: "read_filesystem_file",
          type: "tool_call",
        },
        "tool_call",
      ),
    ).toBe(false);
  });
});
