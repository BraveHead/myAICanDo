import { createAgent } from "langchain";
import { fetchTextFromUrlTool } from "../tools";
import {
  createProjectChatModel,
  type CreateProjectChatModelOptions,
} from "./chat-model";
import type { AgentMessage } from "./weather-agent";

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

type CreateLiteraryAgentOptions = Pick<
  CreateProjectChatModelOptions,
  "apiKey" | "baseURL" | "modelName"
>;

export function createLiteraryAgent({
  apiKey,
  baseURL,
  modelName,
}: CreateLiteraryAgentOptions) {
  const model = createProjectChatModel({
    apiKey,
    baseURL,
    modelName,
    temperature: 0.3,
    timeout: 600_000,
  });

  return createAgent({
    model,
    tools: [fetchTextFromUrlTool],
    systemPrompt: SYSTEM_PROMPT,
  });
}

export async function* streamLiteraryAgentText({
  agent,
  messages,
  signal,
}: {
  agent: ReturnType<typeof createLiteraryAgent>;
  messages: AgentMessage[];
  signal: AbortSignal;
}) {
  const result = await agent.invoke(
    { messages },
    {
      signal,
      recursionLimit: 10,
    },
  );
  const lastMessage = result.messages.at(-1);
  const text = normalizeMessageContent(lastMessage?.content);

  if (text) {
    yield text;
  }
}

function normalizeMessageContent(content: unknown) {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      if (part && typeof part === "object" && "text" in part) {
        return String(part.text ?? "");
      }

      return "";
    })
    .join("");
}
