import { describe, expect, test } from "bun:test";
import { buildHarnessSystemPrompt } from "../src/lib/agent/harness/context/prompt.ts";

describe("context prompt builder", () => {
  test("builds prompt sections in a stable order", () => {
    const prompt = buildHarnessSystemPrompt({
      agentPrompt: "agent rules",
      memoryContext: "memory item",
      skillsContext: "skill item",
      todoState: {
        agentId: "filesystem",
        revision: 2,
        todos: [
          {
            content: "读取大文件",
            id: "todo_1",
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
      "## skills",
      "## tool-guidance",
    ].map((section) => prompt.indexOf(section));

    expect(sectionOrder.every((index) => index >= 0)).toBe(true);
    expect(sectionOrder).toEqual([...sectionOrder].sort((left, right) => left - right));
    expect(prompt).toContain("agent rules");
    expect(prompt).toContain("已保存的用户记忆");
    expect(prompt).toContain("skill item");
    expect(prompt).toContain("todo_1: [in_progress] 读取大文件");
    expect(prompt).toContain("工具结果 offloading");
  });

  test("omits empty memory and skills sections", () => {
    const prompt = buildHarnessSystemPrompt({
      agentPrompt: "agent rules",
    });

    expect(prompt).toContain("## base");
    expect(prompt).toContain("## agent");
    expect(prompt).not.toContain("## memory");
    expect(prompt).not.toContain("## skills");
    expect(prompt).toContain("## tool-guidance");
  });

  test("can disable planning prompt guidance", () => {
    const prompt = buildHarnessSystemPrompt({
      agentPrompt: "agent rules",
      planningEnabled: false,
      todoState: {
        agentId: "filesystem",
        revision: 1,
        todos: [
          {
            content: "不应暴露给子 agent",
            id: "todo_hidden",
            status: "in_progress",
          },
        ],
        updatedAt: "2026-07-15T00:00:00.000Z",
      },
    });

    expect(prompt).not.toContain("write_todos");
    expect(prompt).not.toContain("todo_hidden");
    expect(prompt).toContain("工具结果 offloading");
  });
});
