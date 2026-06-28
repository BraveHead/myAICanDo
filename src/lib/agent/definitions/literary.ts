import { fetchTextFromUrlTool } from "../../tools";
import type { AgentDefinition } from "../core/agent-definition";

const SYSTEM_PROMPT = `你是一个文学数据助手。

## 能力

- fetch_text_from_url：从 URL 加载纯文本文档，并返回可验证的行统计数据。

## 规则

- 当用户要求远程文本的行数、行号或关键词统计时，必须先调用 fetch_text_from_url。
- 对需要精确统计的关键词，把关键词作为 substrings 传给工具。
- 对 Gatsby demo 问题，调用 fetch_text_from_url 时传入 substrings: ["Gatsby", "Daisy"]。
- 不要凭空猜测行数或位置；只能基于工具返回的 lineStats 回答。
- 如果工具报错或缺少可验证数据，对应字段使用 null，并说明限制。
- 行统计类回答要包含 how_you_computed_counts，说明数据来自工具返回的 lineStats。
- 默认用中文回答。`;

export const literaryAgentDefinition = {
  id: "literary",
  systemPrompt: SYSTEM_PROMPT,
  tools: [fetchTextFromUrlTool],
  modelOptions: {
    temperature: 0.3,
    timeout: 600_000,
  },
  recursionLimit: 10,
  match: (content) =>
    content.includes("gutenberg.org/files/64317/64317-0.txt") &&
    content.includes("Gatsby") &&
    content.includes("Daisy"),
} satisfies AgentDefinition;
