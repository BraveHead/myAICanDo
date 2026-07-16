import type { SupportedAgent } from "@/lib/agent/shared/agent-ids";

export type SkillManifest = {
  agents?: SupportedAgent[];
  description: string;
  id: string;
  name: string;
  triggers?: string[];
};

export type SkillSummary = SkillManifest & {
  path: string;
};

export type SkillDocument = SkillSummary & {
  content: string;
};

type SkillToolError = {
  code: string;
  message: string;
};

type SkillToolErrorResult = {
  error: SkillToolError;
  ok: false;
  summary: string;
};

export type ListSkillsResult =
  | {
      ok: true;
      skills: SkillSummary[];
      summary: string;
    }
  | SkillToolErrorResult;

export type ReadSkillResult =
  | {
      ok: true;
      skill: SkillDocument;
      summary: string;
    }
  | SkillToolErrorResult;
