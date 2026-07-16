import type { SkillSummary } from "./types";

export function formatSkillSummariesForPrompt(skills: SkillSummary[]) {
  return skills
    .map((skill) => {
      const triggers = skill.triggers?.length
        ? `\n  triggers: ${skill.triggers.join(", ")}`
        : "";

      return `- ${skill.id} (${skill.name}): ${skill.description}${triggers}\n  使用 read_skill({ skillId: "${skill.id}" }) 读取完整流程。`;
    })
    .join("\n");
}
