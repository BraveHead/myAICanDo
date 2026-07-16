import fs from "node:fs/promises";
import path from "node:path";
import {
  isSupportedAgent,
  type SupportedAgent,
} from "@/lib/agent/shared/agent-ids";
import type {
  ListSkillsResult,
  ReadSkillResult,
  SkillDocument,
  SkillManifest,
  SkillSummary,
} from "./types";

const SKILL_FILE_NAME = "SKILL.md";
const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_SKILL_FILE_BYTES = 64_000;

type SkillStoreOptions = {
  agentId: SupportedAgent;
  query?: string;
  skillsRoot?: string;
};

type ReadSkillOptions = {
  agentId: SupportedAgent;
  skillId: string;
  skillsRoot?: string;
};

type ParsedFrontmatter = Record<string, string | string[]>;
type SkillErrorResult = Extract<ReadSkillResult, { ok: false }>;
type LoadSkillSummariesResult =
  | {
      ok: true;
      skills: SkillSummary[];
    }
  | SkillErrorResult;
type FrontmatterParseResult =
  | {
      data: ParsedFrontmatter;
      ok: true;
    }
  | SkillErrorResult;
type ManifestParseResult =
  | {
      manifest: SkillManifest;
      ok: true;
    }
  | SkillErrorResult;

export async function listSkillsForAgent({
  agentId,
  query,
  skillsRoot = getDefaultSkillsRoot(),
}: SkillStoreOptions): Promise<ListSkillsResult> {
  const summaryResult = await loadSkillSummariesResult(skillsRoot);
  if (!summaryResult.ok) {
    return summaryResult;
  }

  const normalizedQuery = query?.trim().toLowerCase();
  const visibleSkills = summaryResult.skills
    .filter((skill) => isSkillVisibleToAgent(skill, agentId))
    .filter((skill) =>
      normalizedQuery ? matchesSkillQuery(skill, normalizedQuery) : true,
    );

  return {
    ok: true,
    skills: visibleSkills,
    summary: `找到 ${visibleSkills.length} 个可用 skill。`,
  };
}

export async function readSkillForAgent({
  agentId,
  skillId,
  skillsRoot = getDefaultSkillsRoot(),
}: ReadSkillOptions): Promise<ReadSkillResult> {
  if (!isValidSkillId(skillId)) {
    return createSkillError(
      "invalid_skill_id",
      "skillId 只能包含小写字母、数字、下划线和连字符。",
    );
  }

  const readResult = await readSkillDocument(skillsRoot, skillId);
  if (!readResult.ok) {
    return readResult;
  }

  if (!isSkillVisibleToAgent(readResult.skill, agentId)) {
    return createSkillError(
      "skill_not_visible",
      `当前 agent 无权读取 skill ${skillId}。`,
    );
  }

  return {
    ok: true,
    skill: readResult.skill,
    summary: `已读取 skill ${skillId}。`,
  };
}

export async function loadSkillSummaries(
  skillsRoot = getDefaultSkillsRoot(),
): Promise<SkillSummary[]> {
  const result = await loadSkillSummariesResult(skillsRoot);
  if (!result.ok) {
    throw new Error(result.error.message);
  }

  return result.skills;
}

async function loadSkillSummariesResult(
  skillsRoot = getDefaultSkillsRoot(),
): Promise<LoadSkillSummariesResult> {
  const rootExists = await pathExists(skillsRoot);
  if (!rootExists) {
    return {
      ok: true,
      skills: [],
    };
  }

  const entries = await fs.readdir(skillsRoot, {
    withFileTypes: true,
  });
  const summaries: SkillSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidSkillId(entry.name)) {
      continue;
    }

    const result = await readSkillDocument(skillsRoot, entry.name);
    if (!result.ok) {
      return result;
    }

    summaries.push(toSkillSummary(result.skill));
  }

  return {
    ok: true,
    skills: summaries.sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function toSkillSummary(skill: SkillDocument): SkillSummary {
  return {
    ...(skill.agents ? { agents: skill.agents } : {}),
    description: skill.description,
    id: skill.id,
    name: skill.name,
    path: skill.path,
    ...(skill.triggers ? { triggers: skill.triggers } : {}),
  };
}

function getDefaultSkillsRoot() {
  return path.join(process.cwd(), "agent-skills");
}

async function readSkillDocument(
  skillsRoot: string,
  skillId: string,
): Promise<ReadSkillResult> {
  const skillPath = path.join(skillsRoot, skillId, SKILL_FILE_NAME);
  const relativePath = path.join("agent-skills", skillId, SKILL_FILE_NAME);

  try {
    const stats = await fs.stat(skillPath);
    if (!stats.isFile()) {
      return createSkillError(
        "skill_not_found",
        `未找到 skill ${skillId}。`,
      );
    }

    if (stats.size > MAX_SKILL_FILE_BYTES) {
      return createSkillError(
        "skill_too_large",
        `skill ${skillId} 超过 ${MAX_SKILL_FILE_BYTES} bytes 限制。`,
      );
    }

    const raw = await fs.readFile(skillPath, "utf8");
    const parsed = parseSkillMarkdown(raw, skillId, relativePath);
    if (!parsed.ok) {
      return parsed;
    }

    return {
      ok: true,
      skill: parsed.skill,
      summary: `已读取 skill ${skillId}。`,
    };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return createSkillError(
        "skill_not_found",
        `未找到 skill ${skillId}。`,
      );
    }

    return createSkillError(
      "skill_parse_error",
      error instanceof Error ? error.message : "读取 skill 失败。",
    );
  }
}

function parseSkillMarkdown(
  raw: string,
  expectedId: string,
  relativePath: string,
): ReadSkillResult {
  const normalizedRaw = raw.replace(/\r\n/g, "\n");
  const lines = normalizedRaw.split("\n");
  if (lines[0] !== "---") {
    return createSkillError(
      "skill_parse_error",
      "SKILL.md 必须以 frontmatter 开头。",
    );
  }

  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && line === "---",
  );
  if (closingIndex < 0) {
    return createSkillError(
      "skill_parse_error",
      "SKILL.md 缺少 frontmatter 结束标记。",
    );
  }

  const frontmatter = parseFrontmatter(lines.slice(1, closingIndex));
  if (!frontmatter.ok) {
    return frontmatter;
  }

  const manifest = createSkillManifest(frontmatter.data, expectedId);
  if (!manifest.ok) {
    return manifest;
  }

  const content = lines.slice(closingIndex + 1).join("\n").trim();
  const skill: SkillDocument = {
    ...manifest.manifest,
    content,
    path: relativePath,
  };

  return {
    ok: true,
    skill,
    summary: `已读取 skill ${expectedId}。`,
  };
}

function parseFrontmatter(lines: string[]): FrontmatterParseResult {
  const data: ParsedFrontmatter = {};
  let currentArrayKey: string | null = null;

  for (const line of lines) {
    if (!line.trim()) {
      continue;
    }

    const arrayItemMatch = line.match(/^\s*-\s+(.+)$/);
    if (arrayItemMatch && currentArrayKey) {
      const currentValue = data[currentArrayKey];
      if (!Array.isArray(currentValue)) {
        return createSkillError(
          "skill_parse_error",
          `frontmatter 字段 ${currentArrayKey} 不是数组。`,
        );
      }
      currentValue.push(stripQuotes(arrayItemMatch[1].trim()));
      continue;
    }

    const keyValueMatch = line.match(/^([a-zA-Z][\w-]*):\s*(.*)$/);
    if (!keyValueMatch) {
      return createSkillError(
        "skill_parse_error",
        `无法解析 frontmatter 行：${line}`,
      );
    }

    const [, key, rawValue] = keyValueMatch;
    if ((key === "agents" || key === "triggers") && !rawValue.trim()) {
      data[key] = [];
      currentArrayKey = key;
      continue;
    }

    data[key] = parseInlineValue(rawValue.trim());
    currentArrayKey = null;
  }

  return {
    data,
    ok: true,
  };
}

function parseInlineValue(rawValue: string) {
  if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
    const innerValue = rawValue.slice(1, -1).trim();
    return innerValue
      ? innerValue.split(",").map((item) => stripQuotes(item.trim()))
      : [];
  }

  return stripQuotes(rawValue);
}

function createSkillManifest(
  data: ParsedFrontmatter,
  expectedId: string,
): ManifestParseResult {
  const id = getRequiredString(data, "id");
  const name = getRequiredString(data, "name");
  const description = getRequiredString(data, "description");
  if (!id || !name || !description) {
    return createSkillError(
      "skill_parse_error",
      "frontmatter 必须包含 id、name 和 description。",
    );
  }

  if (!isValidSkillId(id) || id !== expectedId) {
    return createSkillError(
      "skill_parse_error",
      "frontmatter id 必须是安全 id，并且等于目录名。",
    );
  }

  const agents = getOptionalStringArray(data, "agents");
  if (agents && !agents.every(isSupportedAgent)) {
    return createSkillError(
      "skill_parse_error",
      "agents 只能包含已支持的 agent id。",
    );
  }

  return {
    manifest: {
      ...(agents && agents.length > 0
        ? { agents: agents as SupportedAgent[] }
        : {}),
      description,
      id,
      name,
      triggers: getOptionalStringArray(data, "triggers"),
    },
    ok: true,
  };
}

function getRequiredString(data: ParsedFrontmatter, key: string) {
  const value = data[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getOptionalStringArray(data: ParsedFrontmatter, key: string) {
  const value = data[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    return value.trim() ? [value.trim()] : [];
  }

  return value.map((item) => item.trim()).filter(Boolean);
}

function isSkillVisibleToAgent(skill: SkillManifest, agentId: SupportedAgent) {
  return !skill.agents?.length || skill.agents.includes(agentId);
}

function matchesSkillQuery(skill: SkillSummary, normalizedQuery: string) {
  const searchableText = [
    skill.id,
    skill.name,
    skill.description,
    ...(skill.triggers ?? []),
  ]
    .join("\n")
    .toLowerCase();

  return searchableText.includes(normalizedQuery);
}

function isValidSkillId(value: string) {
  return SKILL_ID_PATTERN.test(value);
}

async function pathExists(targetPath: string) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function stripQuotes(value: string) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function createSkillError(
  code: string,
  message: string,
): SkillErrorResult {
  return {
    error: {
      code,
      message,
    },
    ok: false,
    summary: `Skill 操作失败：${message}`,
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
