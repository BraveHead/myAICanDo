import { ChatOpenAI } from "@langchain/openai";
import { createAgent } from "langchain";
import { getWeatherTool } from "../tools";

export type AgentMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type CreateWeatherAgentOptions = {
  apiKey: string;
  baseURL?: string;
  modelName: string;
};

export function createWeatherAgent({
  apiKey,
  baseURL,
  modelName,
}: CreateWeatherAgentOptions) {
  const model = new ChatOpenAI({
    apiKey,
    model: modelName,
    temperature: 0.3,
    streamUsage: false,
    configuration: baseURL ? { baseURL } : undefined,
  });

  return createAgent({
    model,
    tools: [getWeatherTool],
    systemPrompt:
      "你是一个中文 AI 助手。遇到天气查询时，优先调用 get_weather 工具，并用中文简洁回答。",
  });
}

export async function* streamWeatherAgentText({
  agent,
  messages,
  signal,
}: {
  agent: ReturnType<typeof createWeatherAgent>;
  messages: AgentMessage[];
  signal: AbortSignal;
}) {
  const result = await agent.invoke(
    { messages },
    {
      signal,
      recursionLimit: 8,
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
