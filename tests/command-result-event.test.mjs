import { describe, expect, test } from "bun:test";
import {
  encodeChatSseEvent,
  isChatStreamEvent,
} from "../src/lib/chat-stream.ts";

describe("M9 command result events", () => {
  test("encodes and validates a bounded command result event", () => {
    const event = {
      approvalId: "approval_1",
      args: ["workspace"],
      command: "ls",
      cwd: "workspace",
      durationMs: 12,
      executionId: "exec_1",
      exitCode: 0,
      finishedAt: "2026-07-21T00:00:00.000Z",
      outputTruncated: false,
      status: "completed",
      stderr: "",
      stdout: "report.md",
      summary: "命令已完成",
      type: "command_result",
    };

    expect(isChatStreamEvent(event, "command_result")).toBe(true);
    expect(encodeChatSseEvent(event)).toContain("event: command_result");
    expect(encodeChatSseEvent(event)).toContain('"stdout":"report.md"');
  });

  test("rejects incomplete or unsafe status payloads", () => {
    expect(
      isChatStreamEvent(
        {
          args: [],
          command: "pwd",
          cwd: "workspace",
          durationMs: 1,
          executionId: "exec_1",
          finishedAt: "2026-07-21T00:00:00.000Z",
          outputTruncated: false,
          status: "running",
          stderr: "",
          stdout: "",
          summary: "bad",
          type: "command_result",
        },
        "command_result",
      ),
    ).toBe(false);
  });

  test("keeps M10 cancelled and expired terminal results compatible", () => {
    for (const status of ["cancelled", "expired"]) {
      expect(
        isChatStreamEvent(
          {
            args: [],
            command: "pwd",
            cwd: "workspace",
            durationMs: 1,
            executionId: `exec_${status}`,
            finishedAt: "2026-07-23T00:00:00.000Z",
            outputTruncated: false,
            status,
            stderr: "",
            stdout: "",
            summary: status,
            type: "command_result",
          },
          "command_result",
        ),
      ).toBe(true);
    }
  });
});
