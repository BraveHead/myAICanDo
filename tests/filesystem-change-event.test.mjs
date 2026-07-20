import { describe, expect, test } from "bun:test";

const { createFilesystemChangeEvent } = await import(
  "../src/lib/chat-stream-projection.ts"
);

describe("M8 filesystem change events", () => {
  test("maps write, edit, and delete results without exposing content", () => {
    const write = createFilesystemChangeEvent({
      args: { content: "secret content", path: "workspace/report.md" },
      result: {
        content: JSON.stringify({
          ok: true,
          operation: "create",
          path: "workspace/report.md",
          sizeBytes: 148,
          summary: "已创建文件",
        }),
      },
      toolCallId: "call_write",
      toolName: "write_file",
    });
    const edit = createFilesystemChangeEvent({
      args: { newText: "new", oldText: "old", path: "workspace/report.md" },
      result: {
        content: JSON.stringify({
          newSizeBytes: 3,
          ok: true,
          path: "workspace/report.md",
          replacements: 1,
          summary: "已编辑文件",
        }),
      },
      toolCallId: "call_edit",
      toolName: "edit_file",
    });
    const del = createFilesystemChangeEvent({
      args: { path: "workspace/report.md" },
      result: {
        content: JSON.stringify({
          ok: true,
          path: "workspace/report.md",
          sizeBytes: 3,
          summary: "已删除文件",
        }),
      },
      toolCallId: "call_delete",
      toolName: "delete_file",
    });

    expect(write).toMatchObject({
      operation: "create",
      path: "workspace/report.md",
      sizeBytes: 148,
      status: "completed",
    });
    expect(edit).toMatchObject({
      operation: "edit",
      replacements: 1,
      status: "completed",
    });
    expect(del).toMatchObject({ operation: "delete", status: "completed" });
    expect(JSON.stringify(write)).not.toContain("secret content");
    expect(createFilesystemChangeEvent({
      result: { ok: true, path: "workspace/report.md" },
      toolName: "read_filesystem_file",
    })).toBeNull();
  });

  test("represents rejection/failure without claiming completion", () => {
    expect(
      createFilesystemChangeEvent({
        args: { path: "workspace/report.md" },
        result: { ok: false, summary: "用户取消操作" },
        status: "rejected",
        toolName: "delete_file",
      }),
    ).toMatchObject({
      operation: "delete",
      status: "rejected",
    });
  });
});
