import { tool } from "langchain";
import * as z from "zod";
import type { AgentDefinition } from "../core/agent-definition";

// 一个最小的内联工具：返回当前时间。仅用于演示 agent 的工具调用能力。
const getCurrentTimeTool = tool(() => new Date().toISOString(), {
  name: "get_current_time",
  description: "返回当前的 ISO 时间字符串。",
  schema: z.object({}),
});

/**
 * 最小 demo agent 定义。
 *
 * 接入项目现有的 agent 管线（/api/chat → agent-runner），
 * 因此点击默认问题后会进入真实会话线程，可以继续追问。
 */
export const demoAgentDefinition = {
  id: "demo",
  systemPrompt:
    "你是一个最小化的中文 demo 助手，需要当前时间时可调用 get_current_time 工具，并用中文简洁回答。",
  tools: [getCurrentTimeTool],
  modelOptions: {
    temperature: 0.3,
  },
  recursionLimit: 8,
  match: (content) => content === "现在几点了？请顺带自我介绍一句。",
} satisfies AgentDefinition;
