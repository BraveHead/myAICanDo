import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { validateExecuteCommandArgs } = await import(
  "../src/lib/command-execution/command-policy.ts"
);
const { executeCommandInSandbox, prepareCommandApprovalPreview } = await import(
  "../src/lib/command-execution/execution-service.ts"
);

let root;
let previousRoot;

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
  root = await fs.mkdtemp(path.join(os.tmpdir(), "m9-command-policy-"));
  process.env.FILESYSTEM_SANDBOX_ROOT = root;
  await fs.mkdir(path.join(root, "tenant_a", "user_a", "thread_a", "workspace"), {
    recursive: true,
  });
});

afterEach(async () => {
  if (previousRoot === undefined) {
    delete process.env.FILESYSTEM_SANDBOX_ROOT;
  } else {
    process.env.FILESYSTEM_SANDBOX_ROOT = previousRoot;
  }
  await fs.rm(root, { force: true, recursive: true });
});

describe("M9 execute_command policy", () => {
  test("allows safe commands and rejects shell/network/path escape inputs", () => {
    expect(
      validateExecuteCommandArgs({ command: "pwd", cwd: "workspace" }),
    ).toEqual({
      ok: true,
      value: {
        args: [],
        command: "pwd",
        cwd: "workspace",
        timeoutMs: 30_000,
      },
    });
    expect(
      validateExecuteCommandArgs({ command: "bun", args: ["run", "typecheck"] }),
    ).toMatchObject({ ok: true });
    expect(
      validateExecuteCommandArgs({
        command: "cat",
        args: ["hello.txt"],
        cwd: "workspace",
      }),
    ).toMatchObject({ ok: true });

    for (const args of [
      { command: "sh", args: ["-c", "pwd"] },
      { command: "curl", args: ["https://example.com"] },
      { command: "rm", args: ["workspace/a.txt"] },
      { command: "ls", cwd: "../" },
      { command: "ls", cwd: "/etc" },
      { command: "ls", args: ["../../etc"] },
      { command: "pwd", env: { SECRET: "no" } },
    ]) {
      expect(validateExecuteCommandArgs(args)).toMatchObject({ ok: false });
    }
  });

  test("rejects symlinked execution roots", async () => {
    const threadRoot = path.join(root, "tenant_a", "user_a", "thread_a");
    await fs.symlink(os.tmpdir(), path.join(threadRoot, "notes"));

    await expect(
      prepareCommandApprovalPreview({ command: "pwd", cwd: "notes" }, context),
    ).rejects.toThrow("symlink");
  });

  test("rejects symlinked command path arguments", async () => {
    const workspaceRoot = path.join(
      root,
      "tenant_a",
      "user_a",
      "thread_a",
      "workspace",
    );
    await fs.symlink(os.tmpdir(), path.join(workspaceRoot, "linked.txt"));

    await expect(
      prepareCommandApprovalPreview(
        { command: "cat", args: ["linked.txt"], cwd: "workspace" },
        context,
      ),
    ).rejects.toThrow("symlink");
  });

  test("passes a read-only scoped request to the injected executor", async () => {
    let received;
    const executor = {
      execute(request) {
        received = request;
        return Promise.resolve({
          args: request.args,
          command: request.command,
          cwd: request.cwd,
          durationMs: 4,
          executionId: "exec:test",
          finishedAt: "2026-07-21T00:00:00.000Z",
          outputTruncated: false,
          status: "completed",
          stderr: "",
          stdout: "workspace",
          summary: "已完成",
        });
      },
    };

    const result = await executeCommandInSandbox(
      { command: "pwd", cwd: "workspace" },
      context,
      executor,
    );

    expect(result).toMatchObject({
      commandResult: { executionId: "exec:test", status: "completed" },
      ok: true,
    });
    expect(received).toMatchObject({
      command: "pwd",
      cwd: "workspace",
      outputLimitBytes: 131072,
      readOnly: true,
      timeoutMs: 30000,
    });
    expect(received.allowedRoots).toHaveLength(2);
  });
});
