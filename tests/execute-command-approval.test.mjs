import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const {
  executeApprovalTool,
  prepareApprovalAction,
} = await import("../src/lib/approval-policy.ts");

let root;
let previousRoot;
let previousBackend;

const context = {
  threadId: "thread_a",
  threadScope: {
    tenantHashId: "tenant_a",
    userHashId: "user_a",
    workspaceId: "ws_a",
  },
};

beforeEach(async () => {
  previousRoot = process.env.FILESYSTEM_SANDBOX_ROOT;
  previousBackend = process.env.EXECUTION_SANDBOX_BACKEND;
  root = await fs.mkdtemp(path.join(os.tmpdir(), "m9-approval-"));
  process.env.FILESYSTEM_SANDBOX_ROOT = root;
  process.env.EXECUTION_SANDBOX_BACKEND = "mock";
  await fs.mkdir(
    path.join(root, "tenant_a", "user_a", "thread_a", "workspace"),
    { recursive: true },
  );
});

afterEach(async () => {
  if (previousRoot === undefined) {
    delete process.env.FILESYSTEM_SANDBOX_ROOT;
  } else {
    process.env.FILESYSTEM_SANDBOX_ROOT = previousRoot;
  }
  if (previousBackend === undefined) {
    delete process.env.EXECUTION_SANDBOX_BACKEND;
  } else {
    process.env.EXECUTION_SANDBOX_BACKEND = previousBackend;
  }
  await fs.rm(root, { force: true, recursive: true });
});

describe("M9 execute_command approval", () => {
  test("creates a preview and refuses execution when the sandbox is unavailable", async () => {
    const prepared = await prepareApprovalAction({
      args: { command: "pwd", cwd: "workspace" },
      context,
      toolName: "execute_command",
    });

    expect(prepared).toMatchObject({
      requiresApproval: true,
      preview: {
        cwd: "workspace",
        filesystem: "read-only",
        kind: "command",
        network: "disabled",
      },
    });

    const result = await executeApprovalTool({
      args: { command: "pwd", cwd: "workspace" },
      context,
      toolName: "execute_command",
    });

    expect(result).toMatchObject({
      commandResult: { status: "sandbox_unavailable" },
      ok: false,
    });
  });
});
