import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const {
  createApprovalOptions,
  executeApprovalTool,
  getApprovalPolicy,
  prepareApprovalAction,
} = await import("../src/lib/approval-policy.ts");

let root;
let previousRoot;

beforeEach(async () => {
  previousRoot = process.env.FILESYSTEM_SANDBOX_ROOT;
  root = await fs.mkdtemp(path.join(os.tmpdir(), "approval-policy-"));
  process.env.FILESYSTEM_SANDBOX_ROOT = root;
});

afterEach(async () => {
  if (previousRoot === undefined) {
    delete process.env.FILESYSTEM_SANDBOX_ROOT;
  } else {
    process.env.FILESYSTEM_SANDBOX_ROOT = previousRoot;
  }
  await fs.rm(root, { force: true, recursive: true });
});

const scope = {
  tenantHashId: "tenant_a",
  userHashId: "user_a",
  workspaceId: "ws_a",
};

const context = {
  threadId: "thread_a",
  threadScope: scope,
};

describe("M7 approval policy registry", () => {
  test("registers only the five existing mutation tools", () => {
    const names = [
      "write_file",
      "edit_file",
      "delete_file",
      "save_memory",
      "delete_memory",
    ];

    for (const name of names) {
      expect(getApprovalPolicy(name)).toMatchObject({
        supportsEditArgs: true,
        toolName: name,
      });
    }

    expect(getApprovalPolicy("task")).toBeUndefined();
    expect(createApprovalOptions("write_file")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "approve-once" }),
        expect.objectContaining({ id: "edit-and-execute", kind: "_edit_args" }),
        expect.objectContaining({ id: "provide-guidance", kind: "_guidance" }),
        expect.objectContaining({ id: "reject-once" }),
      ]),
    );
  });

  test("validates and previews file mutations before approval", async () => {
    await fs.mkdir(path.join(root, "tenant_a", "user_a", "thread_a"), {
      recursive: true,
    });

    const prepared = await prepareApprovalAction({
      args: {
        content: "report",
        path: "workspace/report.md",
      },
      context,
      toolName: "write_file",
    });

    expect(prepared.requiresApproval).toBe(true);
    expect(prepared.preview).toMatchObject({
      kind: "write",
      path: "workspace/report.md",
    });

    const invalid = await executeApprovalTool({
      args: {
        content: "blocked",
        path: "../outside.txt",
      },
      context,
      toolName: "write_file",
    });
    expect(invalid).toMatchObject({
      error: { code: "invalid_path" },
      ok: false,
    });
  });
});
