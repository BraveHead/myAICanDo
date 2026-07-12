import { createMemoryTools } from "../../tools";
import type { AgentDefinition } from "../core/agent-definition";
import { structuredAgentResponseFormat } from "../shared/response-format";

const SYSTEM_PROMPT = `你是一个长期记忆助手。

## 能力

- save_memory：保存当前租户和用户下的一条长期记忆。
- list_memories：列出或搜索当前租户和用户下已经保存的长期记忆，默认只返回 active 记忆；用户询问历史、被覆盖、已删除或全部记忆时，才使用 includeHistory/status 查询。
- delete_memory：按 memory_id 删除当前租户和用户下的一条长期记忆。

## 规则

- v1 只支持显式记忆：只有用户明确要求“记住、保存、记录、以后请记得”等表达时，才可以调用 save_memory。
- 不要从普通聊天中自动抽取和保存记忆。
- 当用户询问“你记住了什么、我的偏好是什么、查找记忆”等问题时，先调用 list_memories。
- 当用户询问“历史记忆、被覆盖的记忆、已删除的记忆、为什么现在使用某个偏好”时，调用 list_memories 并传入 includeHistory 或明确 status。
- 当用户要求忘记或删除某条记忆时，如果没有明确 memory_id，先调用 list_memories 找候选，并请用户确认要删除哪一条。
- 回答当前偏好或事实时，只把 active 记忆当成当前有效记忆；superseded/deleted 只能作为历史说明。
- 只能基于工具返回的结果回答，不要编造不存在的记忆。
- 不保存银行卡、密码、密钥、身份证件号等敏感信息；如果用户要求保存这类内容，说明不支持保存。
- 保存内容要简短、客观、可复查。
- 默认用中文回答。`;

function matchesMemoryIntent(content: string) {
  const normalizedContent = content.trim();
  if (!normalizedContent) {
    return false;
  }

  return (
    normalizedContent.includes("请记住") ||
    normalizedContent.includes("记住：") ||
    normalizedContent.includes("保存记忆") ||
    normalizedContent.includes("记录下来") ||
    normalizedContent.includes("以后请记得") ||
    normalizedContent.includes("你记住了什么") ||
    normalizedContent.includes("查看记忆") ||
    normalizedContent.includes("查询记忆") ||
    normalizedContent.includes("列出记忆") ||
    normalizedContent.includes("删除记忆") ||
    normalizedContent.includes("忘记")
  );
}

export const memoryAgentDefinition = {
  id: "memory",
  systemPrompt: SYSTEM_PROMPT,
  tools: ({ threadId, threadScope }) =>
    createMemoryTools({
      threadId,
      threadScope,
    }),
  modelOptions: {
    temperature: 0.2,
  },
  responseFormat: structuredAgentResponseFormat,
  recursionLimit: 6,
  match: matchesMemoryIntent,
} satisfies AgentDefinition;
