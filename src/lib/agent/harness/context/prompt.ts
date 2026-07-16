import type { TodoState } from "@/lib/agent/harness/planning";
import { buildPlanningPromptContext } from "@/lib/agent/harness/planning";
import type { ContextOffloadPolicy } from "./tool-result-offload";

type PromptSectionKey =
  | "base"
  | "agent"
  | "memory"
  | "skills"
  | "tool-guidance";

type PromptBuildContext = {
  agentPrompt: string;
  basePrompt?: string;
  memoryContext?: string;
  offloadPolicy?: ContextOffloadPolicy;
  planningEnabled?: boolean;
  skillsContext?: string;
  todoState?: TodoState | null;
};

type PromptSection = {
  content: string;
  key: PromptSectionKey;
};

const DEFAULT_BASE_PROMPT = `你运行在 myAICanDo 的 AgentHarness 中。

- 遵守当前租户、用户和线程隔离边界。
- 只能把工具返回、已保存记忆、当前消息和系统 prompt 中明确提供的信息当作依据。
- 默认用中文回答，除非用户明确要求其它语言。`;

const PROMPT_SECTION_ORDER: PromptSectionKey[] = [
  "base",
  "agent",
  "memory",
  "skills",
  "tool-guidance",
];

export function buildHarnessSystemPrompt({
  agentPrompt,
  basePrompt = DEFAULT_BASE_PROMPT,
  memoryContext,
  offloadPolicy,
  planningEnabled = true,
  skillsContext,
  todoState,
}: PromptBuildContext) {
  const sections: PromptSection[] = [
    {
      key: "base",
      content: basePrompt,
    },
    {
      key: "agent",
      content: agentPrompt,
    },
    {
      key: "memory",
      content: formatMemoryContext(memoryContext),
    },
    {
      key: "skills",
      content: formatSkillsContext(skillsContext),
    },
    {
      key: "tool-guidance",
      content: [
        planningEnabled ? buildPlanningPromptContext(todoState) : "",
        buildOffloadPromptContext(offloadPolicy),
      ].join("\n\n"),
    },
  ];

  return sections
    .filter((section) => section.content.trim())
    .sort(
      (left, right) =>
        PROMPT_SECTION_ORDER.indexOf(left.key) -
        PROMPT_SECTION_ORDER.indexOf(right.key),
    )
    .map((section) => `## ${section.key}\n\n${section.content.trim()}`)
    .join("\n\n");
}

function formatMemoryContext(memoryContext: string | undefined) {
  return memoryContext?.trim()
    ? `已保存的用户记忆：\n\n${memoryContext.trim()}`
    : "";
}

function formatSkillsContext(skillsContext: string | undefined) {
  return skillsContext?.trim()
    ? `当前可用 skills：\n\n${skillsContext.trim()}`
    : "";
}

function buildOffloadPromptContext(policy: ContextOffloadPolicy | undefined) {
  const effectivePolicy = {
    maxInlineContentChars: policy?.maxInlineContentChars ?? 8_000,
    maxInlineResultBytes: policy?.maxInlineResultBytes ?? 12_000,
  };

  return `## 工具结果 offloading

- 工具结果超过 ${effectivePolicy.maxInlineResultBytes} bytes，或 read_filesystem_file 的 content 超过 ${effectivePolicy.maxInlineContentChars} 字符时，系统会把原始结果写入 .context/offloads/*.json。
- 主上下文中的工具结果只保留 summary、offloaded、artifactPath 和 originalSizeBytes。
- 如果你需要复查被 offload 的原文，显式调用 read_filesystem_file 读取 artifactPath。
- 回答时可以引用 artifactPath 作为依据；不要假装主上下文里仍包含完整原文。`;
}
