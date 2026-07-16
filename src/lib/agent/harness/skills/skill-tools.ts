import { tool } from "langchain";
import * as z from "zod";
import type { Logger } from "pino";
import type { SupportedAgent } from "@/lib/agent/shared/agent-ids";
import { listSkillsForAgent, readSkillForAgent } from "./skill-store";

type SkillToolContext = {
  agentId: SupportedAgent;
  runLogger?: Logger;
};

const skillIdSchema = z
  .string()
  .min(1)
  .max(64)
  .describe("Skill id, for example filesystem-report.");

export function createSkillTools(context: SkillToolContext) {
  return [
    tool(
      async ({ query }) => {
        const result = await listSkillsForAgent({
          agentId: context.agentId,
          query,
        });
        context.runLogger?.debug(
          {
            skillCount: result.ok ? result.skills.length : 0,
          },
          "list_skills completed",
        );
        return jsonResult(result);
      },
      {
        name: "list_skills",
        description:
          "List project skills available to the current agent. Results include only metadata; call read_skill before following a skill workflow.",
        schema: z.object({
          query: z
            .string()
            .min(1)
            .max(200)
            .optional()
            .describe("Optional text used to filter skills by id, name, description, or triggers."),
        }),
      },
    ),
    tool(
      async ({ skillId }) => {
        const result = await readSkillForAgent({
          agentId: context.agentId,
          skillId,
        });
        context.runLogger?.debug(
          {
            skillId,
            status: result.ok ? "ok" : result.error.code,
          },
          "read_skill completed",
        );
        return jsonResult(result);
      },
      {
        name: "read_skill",
        description:
          "Read the full Markdown instructions for one project skill by id. This is read-only and does not execute scripts.",
        schema: z.object({
          skillId: skillIdSchema,
        }),
      },
    ),
  ];
}

function jsonResult(value: unknown) {
  return JSON.stringify(value);
}
