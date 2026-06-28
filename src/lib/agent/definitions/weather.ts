import { getWeatherTool } from "../../tools";
import type { AgentDefinition } from "../core/agent-definition";

export const weatherAgentDefinition = {
  id: "weather",
  systemPrompt:
    "你是一个中文 AI 助手。遇到天气查询时，优先调用 get_weather 工具，并用中文简洁回答。",
  tools: [getWeatherTool],
  modelOptions: {
    temperature: 0.3,
  },
  recursionLimit: 8,
  match: (content) => content === "What's the weather in San Francisco?",
} satisfies AgentDefinition;
