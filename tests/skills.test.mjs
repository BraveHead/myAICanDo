import { describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

mock.module("server-only", () => ({}));

const {
  formatSkillSummariesForPrompt,
  listSkillsForAgent,
  readSkillForAgent,
} = await import("../src/lib/agent/harness/skills/index.ts");
const { createHarnessedAgent } = await import(
  "../src/lib/agent/harness/agent-harness.ts"
);
const { filesystemAgentDefinition } = await import(
  "../src/lib/agent/definitions/filesystem.ts"
);

const scope = {
  tenantHashId: "tenant_skills",
  userHashId: "user_skills",
};

describe("M5 skills", () => {
  test("scans agent-skills and parses skill summaries", async () => {
    const result = await listSkillsForAgent({
      agentId: "filesystem",
    });

    expect(result.ok).toBe(true);
    const skill = result.skills.find(({ id }) => id === "filesystem-report");
    expect(skill).toEqual({
      agents: ["coordinator", "filesystem"],
      description: "读取当前线程 sandbox 文件并生成结构化中文报告。",
      id: "filesystem-report",
      name: "filesystem-report",
      path: "agent-skills/filesystem-report/SKILL.md",
      triggers: ["总结文件", "生成报告", "分析目录"],
    });
    expect(JSON.stringify(skill)).not.toContain("## Steps");
  });

  test("filters visible skills by agent and query", async () => {
    const filesystemResult = await listSkillsForAgent({
      agentId: "filesystem",
      query: "报告",
    });
    const memoryResult = await listSkillsForAgent({
      agentId: "memory",
    });

    expect(filesystemResult.ok).toBe(true);
    expect(filesystemResult.skills.map(({ id }) => id)).toContain(
      "filesystem-report",
    );
    expect(memoryResult.ok).toBe(true);
    expect(memoryResult.skills.map(({ id }) => id)).not.toContain(
      "filesystem-report",
    );
  });

  test("formats prompt context with summaries only", async () => {
    const listResult = await listSkillsForAgent({
      agentId: "filesystem",
    });
    const readResult = await readSkillForAgent({
      agentId: "filesystem",
      skillId: "filesystem-report",
    });

    expect(listResult.ok).toBe(true);
    expect(readResult.ok).toBe(true);

    const promptContext = formatSkillSummariesForPrompt(listResult.skills);

    expect(promptContext).toContain("filesystem-report");
    expect(promptContext).toContain("read_skill");
    expect(promptContext).toContain("总结文件");
    expect(readResult.skill.content).toContain("## Steps");
    expect(promptContext).not.toContain("## Steps");
    expect(promptContext).not.toContain("涉及文件");
  });

  test("read_skill returns the full skill body for visible agents", async () => {
    const result = await readSkillForAgent({
      agentId: "coordinator",
      skillId: "filesystem-report",
    });

    expect(result.ok).toBe(true);
    expect(result.skill.id).toBe("filesystem-report");
    expect(result.skill.content).toContain("# Filesystem Report");
    expect(result.skill.content).toContain("## Output requirements");
  });

  test("read_skill returns stable errors for invalid, missing, and hidden skills", async () => {
    const invalidResult = await readSkillForAgent({
      agentId: "filesystem",
      skillId: "../filesystem-report",
    });
    const missingResult = await readSkillForAgent({
      agentId: "filesystem",
      skillId: "missing-skill",
    });
    const hiddenResult = await readSkillForAgent({
      agentId: "memory",
      skillId: "filesystem-report",
    });

    expect(invalidResult.ok).toBe(false);
    expect(invalidResult.error.code).toBe("invalid_skill_id");
    expect(missingResult.ok).toBe(false);
    expect(missingResult.error.code).toBe("skill_not_found");
    expect(hiddenResult.ok).toBe(false);
    expect(hiddenResult.error.code).toBe("skill_not_visible");
  });

  test("list_skills reports parse errors instead of silently skipping invalid skills", async () => {
    const skillsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "m5-skills-"));
    try {
      await fs.mkdir(path.join(skillsRoot, "broken-skill"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(skillsRoot, "broken-skill", "SKILL.md"),
        [
          "---",
          "id: wrong-id",
          "name: broken-skill",
          "description: invalid fixture",
          "---",
          "",
          "# Broken Skill",
        ].join("\n"),
      );

      const result = await listSkillsForAgent({
        agentId: "filesystem",
        skillsRoot,
      });

      expect(result.ok).toBe(false);
      expect(result.error.code).toBe("skill_parse_error");
      expect(result.summary).toContain("Skill 操作失败");
    } finally {
      await fs.rm(skillsRoot, {
        force: true,
        recursive: true,
      });
    }
  });

  test("harness registers skill tools and injects only the skill summary", async () => {
    const agent = await createHarnessedAgent({
      apiKey: "test-key",
      createMiddleware: () => [],
      definition: filesystemAgentDefinition,
      getCheckpointer: async () => false,
      getCheckpointerType: () => "none",
      modelName: "test-model",
      planningEnabled: false,
      threadId: "thread_skills",
      threadScope: scope,
    });

    expect(getToolNames(agent.options.tools)).toContain("list_skills");
    expect(getToolNames(agent.options.tools)).toContain("read_skill");
    expect(agent.options.systemPrompt).toContain("## skills");
    expect(agent.options.systemPrompt).toContain("filesystem-report");
    expect(agent.options.systemPrompt).not.toContain("## Steps");
  });
});

function getToolNames(tools) {
  return tools.map((tool) => tool.name).sort();
}
