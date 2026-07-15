import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ToolMessage } from "@langchain/core/messages";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildHarnessSystemPrompt } from "../src/lib/agent/harness/context/prompt.ts";
import { offloadToolResultIfNeeded } from "../src/lib/agent/harness/context/tool-result-offload.ts";
import {
  globFilesystemFiles,
  listFilesystemDirectory,
  readFilesystemFile,
  searchFilesystemText,
  writeFilesystemFile,
  writeInternalFilesystemArtifact,
} from "../src/lib/agent/services/filesystem-service.ts";

const context = {
  threadId: "thread_m3_cases",
  threadScope: {
    tenantHashId: "tenant_m3_cases",
    userHashId: "user_m3_cases",
  },
};

let previousSandboxRoot;
let sandboxRoot;

beforeEach(async () => {
  previousSandboxRoot = process.env.FILESYSTEM_SANDBOX_ROOT;
  sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "m3-context-cases-"));
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

describe("M3 Context v1 validation cases", () => {
  test("case 1: prompt uses stable context sections and custom offload policy", () => {
    const prompt = buildHarnessSystemPrompt({
      agentPrompt: "agent section",
      memoryContext: "user prefers concise answers",
      offloadPolicy: {
        maxInlineContentChars: 321,
        maxInlineResultBytes: 654,
      },
      skillsContext: "",
      todoState: {
        agentId: "coordinator",
        revision: 3,
        todos: [
          {
            content: "验证 M3 prompt 分层",
            id: "todo_prompt",
            status: "in_progress",
          },
        ],
        updatedAt: "2026-07-15T00:00:00.000Z",
      },
    });

    const sectionOrder = [
      "## base",
      "## agent",
      "## memory",
      "## tool-guidance",
    ].map((section) => prompt.indexOf(section));

    expect(sectionOrder.every((index) => index >= 0)).toBe(true);
    expect(sectionOrder).toEqual([...sectionOrder].sort((left, right) => left - right));
    expect(prompt).not.toContain("## skills");
    expect(prompt).toContain("agent section");
    expect(prompt).toContain("已保存的用户记忆");
    expect(prompt).toContain("todo_prompt: [in_progress] 验证 M3 prompt 分层");
    expect(prompt).toContain("超过 654 bytes");
    expect(prompt).toContain("content 超过 321 字符");
  });

  test("case 2: large read_file content is offloaded and leaves a small reference", async () => {
    const originalContent = `m3-read-file-marker-${"x".repeat(900)}`;
    const result = await offloadToolResultIfNeeded({
      args: {
        path: "workspace/report.txt",
      },
      policy: {
        maxInlineContentChars: 100,
        maxInlineResultBytes: 100_000,
      },
      result: createToolMessage({
        content: JSON.stringify({
          ok: true,
          path: "workspace/report.txt",
          sizeBytes: originalContent.length,
          content: originalContent,
          summary: "已读取 report.txt。",
        }),
        name: "read_filesystem_file",
        toolCallId: "call_read_large",
      }),
      threadId: context.threadId,
      threadScope: context.threadScope,
      toolCallId: "call_read_large",
      toolName: "read_filesystem_file",
    });

    expect(result.offloaded).toBe(true);

    const reference = JSON.parse(result.result.content);
    expect(reference).toEqual({
      artifactPath: expect.stringMatching(/^\.context\/offloads\/.+\.json$/),
      offloaded: true,
      originalSizeBytes: expect.any(Number),
      summary: "已读取 report.txt。",
    });
    expect(result.result.content).not.toContain(originalContent);
    expect(result.result.metadata.contextOffload).toEqual(reference);

    const artifactRead = await readFilesystemFile(context, reference.artifactPath);
    expect(artifactRead.ok).toBe(true);

    const artifact = JSON.parse(artifactRead.content);
    expect(artifact.toolName).toBe("read_filesystem_file");
    expect(artifact.toolCallId).toBe("call_read_large");
    expect(artifact.originalResult.content).toContain(originalContent);
  });

  test("case 3: generic large JSON tool result is offloaded by byte threshold", async () => {
    const marker = "m3-large-json-marker";
    const matches = Array.from({ length: 80 }, (_, index) => ({
      line: `${marker}-${index}-${"payload".repeat(8)}`,
      lineNumber: index + 1,
      path: `workspace/file-${index}.txt`,
    }));

    const result = await offloadToolResultIfNeeded({
      args: {
        query: marker,
      },
      policy: {
        maxInlineContentChars: 100_000,
        maxInlineResultBytes: 500,
      },
      result: createToolMessage({
        content: JSON.stringify({
          ok: true,
          matches,
          summary: "搜索结果命中 80 条。",
        }),
        name: "search_filesystem_text",
        toolCallId: "call_search_large",
      }),
      threadId: context.threadId,
      threadScope: context.threadScope,
      toolCallId: "call_search_large",
      toolName: "search_filesystem_text",
    });

    expect(result.offloaded).toBe(true);

    const reference = JSON.parse(result.result.content);
    expect(reference.summary).toBe("搜索结果命中 80 条。");
    expect(reference.originalSizeBytes).toBeGreaterThan(500);
    expect(result.result.content).not.toContain(marker);

    const artifactRead = await readFilesystemFile(context, reference.artifactPath);
    expect(artifactRead.ok).toBe(true);
    expect(artifactRead.content).toContain(marker);
  });

  test("case 4: small results and missing thread scope do not offload", async () => {
    const smallResult = await offloadToolResultIfNeeded({
      args: {
        path: "workspace/small.txt",
      },
      result: createToolMessage({
        content: JSON.stringify({
          ok: true,
          content: "hello",
          path: "workspace/small.txt",
          summary: "小结果。",
        }),
        name: "read_filesystem_file",
        toolCallId: "call_small",
      }),
      threadId: context.threadId,
      threadScope: context.threadScope,
      toolCallId: "call_small",
      toolName: "read_filesystem_file",
    });
    const missingContextResult = await offloadToolResultIfNeeded({
      args: {},
      result: createToolMessage({
        content: "x".repeat(20_000),
        name: "generic_tool",
        toolCallId: "call_missing_context",
      }),
      toolCallId: "call_missing_context",
      toolName: "generic_tool",
    });

    expect(smallResult).toEqual({
      offloaded: false,
      reason: "under_limit",
    });
    expect(missingContextResult).toEqual({
      offloaded: false,
      reason: "missing_context",
    });
  });

  test("case 5: internal .context artifacts are hidden by default but explicit paths work", async () => {
    const marker = "m3-internal-artifact-marker";
    const userWrite = await writeFilesystemFile(context, {
      content: marker,
      path: ".context/offloads/user-write.json",
    });
    const internalWrite = await writeInternalFilesystemArtifact(context, {
      content: JSON.stringify({
        marker,
      }),
      path: ".context/offloads/internal-write.json",
    });

    expect(userWrite.ok).toBe(false);
    expect(userWrite.error.code).toBe("permission_denied");
    expect(internalWrite.ok).toBe(true);

    const rootList = await listFilesystemDirectory(context, ".");
    const rootSearch = await searchFilesystemText(context, {
      query: marker,
    });
    const rootGlob = await globFilesystemFiles(context, {
      pattern: "**/*.json",
    });

    expect(rootList.ok).toBe(true);
    expect(rootList.entries.some((entry) => entry.name === ".context")).toBe(false);
    expect(rootSearch.ok).toBe(true);
    expect(rootSearch.matches).toHaveLength(0);
    expect(rootGlob.ok).toBe(true);
    expect(rootGlob.matches.some((match) => match.path.startsWith(".context/"))).toBe(
      false,
    );

    const explicitRead = await readFilesystemFile(
      context,
      ".context/offloads/internal-write.json",
    );
    const explicitSearch = await searchFilesystemText(context, {
      path: ".context",
      query: marker,
    });

    expect(explicitRead.ok).toBe(true);
    expect(explicitRead.content).toContain(marker);
    expect(explicitSearch.ok).toBe(true);
    expect(explicitSearch.matches).toHaveLength(1);
    expect(explicitSearch.matches[0].path).toBe(
      ".context/offloads/internal-write.json",
    );
  });
});

function createToolMessage({ content, name, toolCallId }) {
  return new ToolMessage({
    content,
    name,
    status: "success",
    tool_call_id: toolCallId,
  });
}
