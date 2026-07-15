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
});
