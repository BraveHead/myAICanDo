import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ToolMessage } from "@langchain/core/messages";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { offloadToolResultIfNeeded } from "../src/lib/agent/harness/context/tool-result-offload.ts";
import { readFilesystemFile } from "../src/lib/agent/services/filesystem-service.ts";

const context = {
  threadId: "thread_1",
  threadScope: {
    tenantHashId: "tenant_1",
    userHashId: "user_1",
  },
};

let previousSandboxRoot;
let sandboxRoot;

beforeEach(async () => {
  previousSandboxRoot = process.env.FILESYSTEM_SANDBOX_ROOT;
  sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "context-offload-"));
  process.env.FILESYSTEM_SANDBOX_ROOT = sandboxRoot;
});

afterEach(async () => {
  if (previousSandboxRoot === undefined) {
    delete process.env.FILESYSTEM_SANDBOX_ROOT;
  } else {
    process.env.FILESYSTEM_SANDBOX_ROOT = previousSandboxRoot;
  }

  await fs.rm(sandboxRoot, {
    force: true,
    recursive: true,
  });
});

describe("context tool result offloading", () => {
  test("offloads large read_file results and keeps model content small", async () => {
    const largeContent = "x".repeat(8_500);
    const result = await offloadToolResultIfNeeded({
      args: {
        path: "workspace/large.txt",
      },
      result: createToolMessage({
        content: JSON.stringify({
          ok: true,
          path: "workspace/large.txt",
          sizeBytes: largeContent.length,
          content: largeContent,
          summary: "已读取大文件。",
        }),
        name: "read_filesystem_file",
      }),
      threadId: context.threadId,
      threadScope: context.threadScope,
      toolCallId: "call_1",
      toolName: "read_filesystem_file",
    });

    expect(result.offloaded).toBe(true);
    const reference = JSON.parse(result.result.content);
    expect(reference.offloaded).toBe(true);
    expect(reference.summary).toBe("已读取大文件。");
    expect(reference.artifactPath.startsWith(".context/offloads/")).toBe(true);
    expect(result.result.content).not.toContain(largeContent);

    const artifactRead = await readFilesystemFile(context, reference.artifactPath);
    expect(artifactRead.ok).toBe(true);
    expect(artifactRead.content).toContain(largeContent);
    expect(artifactRead.content).toContain('"originalResult"');
  });

  test("keeps small tool results inline", async () => {
    const result = await offloadToolResultIfNeeded({
      args: {
        path: "workspace/small.txt",
      },
      result: createToolMessage({
        content: JSON.stringify({
          ok: true,
          path: "workspace/small.txt",
          sizeBytes: 5,
          content: "hello",
          summary: "已读取小文件。",
        }),
        name: "read_filesystem_file",
      }),
      threadId: context.threadId,
      threadScope: context.threadScope,
      toolCallId: "call_2",
      toolName: "read_filesystem_file",
    });

    expect(result).toEqual({
      offloaded: false,
      reason: "under_limit",
    });
  });
});

function createToolMessage({ content, name }) {
  return new ToolMessage({
    content,
    name,
    status: "success",
    tool_call_id: "call_1",
  });
}
