import { describe, expect, test } from "bun:test";

const { removeTransientStreamEvents } = await import(
  "../src/lib/thread-storage.ts"
);

describe("M8 transient stream persistence", () => {
  test("removes subagent and filesystem timeline data before repository save", () => {
    const repository = {
      messages: [
        {
          message: {
            content: [
              { type: "text", text: "最终回答" },
              { type: "data", name: "subagent_state", data: {} },
              { type: "data", name: "filesystem_change", data: {} },
              { type: "data", name: "todo_state", data: {} },
            ],
            createdAt: new Date("2026-07-15T00:00:00.000Z"),
            id: "message_1",
            role: "assistant",
          },
          parentId: null,
        },
      ],
    };

    const persisted = removeTransientStreamEvents(repository);
    expect(persisted.messages[0].message.content).toEqual([
      { type: "text", text: "最终回答" },
      { type: "data", name: "todo_state", data: {} },
    ]);
  });
});
