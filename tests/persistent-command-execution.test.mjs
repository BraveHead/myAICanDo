import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import {
  canTransitionCommandExecution,
  isCommandExecutionTerminalStatus,
  isPersistedCommandExecutionEvent,
  reduceCommandExecutionEvent,
} from "../src/lib/command-execution/contracts.ts";
import {
  createSandboxExecutor,
  splitCommandOutputChunks,
} from "../src/lib/command-execution/sandbox-executor.ts";
import { getCommandExecutionThreadAccessError } from "../src/lib/command-execution/access-policy.ts";

const snapshot = {
  agentId: "coordinator",
  approvalId: "approval_1",
  args: [],
  attempt: 1,
  cancelRequestedAt: null,
  command: "pwd",
  createdAt: "2026-07-23T00:00:00.000Z",
  cwd: "workspace",
  executionId: "exec:1",
  finishedAt: null,
  lastEventId: "10",
  leaseExpiresAt: null,
  maxAttempts: 3,
  outputTruncated: false,
  parentExecutionId: null,
  rootExecutionId: "exec:1",
  startedAt: null,
  status: "running",
  stderr: "",
  stdout: "",
  summary: "执行中",
  threadId: "thread_1",
  timeoutMs: 30_000,
  toolCallId: "tool_1",
  updatedAt: "2026-07-23T00:00:00.000Z",
  workspaceId: "workspace_1",
};

describe("M10 persistent command execution", () => {
  test("allows unpersisted thread lists without weakening workspace isolation", () => {
    expect(
      getCommandExecutionThreadAccessError({
        requestedWorkspaceId: "workspace_1",
        storedWorkspaceId: null,
      }),
    ).toMatchObject({
      code: "thread_not_found",
      status: 404,
    });
    expect(
      getCommandExecutionThreadAccessError({
        allowUnpersistedThread: true,
        requestedWorkspaceId: "workspace_1",
        storedWorkspaceId: null,
      }),
    ).toBeNull();
    expect(
      getCommandExecutionThreadAccessError({
        allowUnpersistedThread: true,
        requestedWorkspaceId: "workspace_1",
        storedWorkspaceId: "workspace_2",
      }),
    ).toMatchObject({
      code: "thread_workspace_mismatch",
      status: 403,
    });
  });

  test("keeps terminal tasks terminal and permits cancellation races", () => {
    expect(canTransitionCommandExecution("queued", "running")).toBe(true);
    expect(canTransitionCommandExecution("running", "cancel_requested")).toBe(
      true,
    );
    expect(canTransitionCommandExecution("cancel_requested", "completed")).toBe(
      true,
    );
    expect(canTransitionCommandExecution("failed", "running")).toBe(false);
    expect(isCommandExecutionTerminalStatus("cancelled")).toBe(true);
    expect(isCommandExecutionTerminalStatus("expired")).toBe(true);
  });

  test("deduplicates replayed event ids after reconnect", () => {
    const duplicate = {
      createdAt: "2026-07-23T00:00:01.000Z",
      event: {
        byteLength: 3,
        executionId: "exec:1",
        output: "old",
        stream: "stdout",
        type: "command_output",
      },
      id: "10",
    };
    expect(isPersistedCommandExecutionEvent(duplicate)).toBe(true);
    expect(reduceCommandExecutionEvent(snapshot, duplicate)).toBe(snapshot);

    const next = {
      ...duplicate,
      event: { ...duplicate.event, output: "新" },
      id: "11",
    };
    expect(reduceCommandExecutionEvent(snapshot, next)).toMatchObject({
      lastEventId: "11",
      stdout: "新",
    });
  });

  test("splits UTF-8 output into at most 8 KiB without corrupting text", () => {
    const output = `${"中".repeat(4_000)}${"<script>".repeat(2_000)}`;
    const chunks = splitCommandOutputChunks(output, 8 * 1024);
    expect(chunks.join("")).toBe(output);
    expect(
      chunks.every(
        (chunk) => Buffer.byteLength(chunk, "utf8") <= 8 * 1024,
      ),
    ).toBe(true);
  });

  test("preserves a fixed execution id when sandbox is unavailable", async () => {
    const previousBackend = process.env.EXECUTION_SANDBOX_BACKEND;
    process.env.EXECUTION_SANDBOX_BACKEND = "mock";
    try {
      const result = await createSandboxExecutor().execute(
        {
          allowedRoots: ["/tmp/thread/workspace", "/tmp/thread/notes"],
          args: [],
          command: "pwd",
          cwd: "workspace",
          outputLimitBytes: 128 * 1024,
          readOnly: true,
          timeoutMs: 30_000,
        },
        { executionId: "exec:fixed" },
      );
      expect(result.executionId).toBe("exec:fixed");
      expect(result.status).toBe("sandbox_unavailable");
    } finally {
      if (previousBackend === undefined) {
        delete process.env.EXECUTION_SANDBOX_BACKEND;
      } else {
        process.env.EXECUTION_SANDBOX_BACKEND = previousBackend;
      }
    }
  });

  test("store uses durable events, heartbeat and SKIP LOCKED claiming", async () => {
    const source = await fs.readFile(
      new URL(
        "../src/lib/command-execution/execution-repository.ts",
        import.meta.url,
      ),
      "utf8",
    );
    expect(source).toContain("assistant_command_execution_events");
    expect(source).toContain("assistant_command_worker_heartbeats");
    expect(source).toContain("FOR UPDATE SKIP LOCKED");
    expect(source).toContain("worker_lost");
    expect(source).toContain("root_execution_id");
    const finalizer = source.slice(
      source.indexOf("export async function finalizeCommandExecution"),
      source.indexOf("export async function failLostCommandExecutions"),
    );
    expect(finalizer).toContain(
      "AND status IN ('running', 'cancel_requested')",
    );
    expect(finalizer).toContain("update.rowCount");
  });
});
