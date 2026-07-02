import { createAgent, tool } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import * as z from "zod";

// 一个最小的内联工具：返回当前时间。仅用于演示 agent 的工具调用能力。
const getCurrentTimeTool = tool(() => new Date().toISOString(), {
  name: "get_current_time",
  description: "返回当前的 ISO 时间字符串。",
  schema: z.object({}),
});

/**
 * 最小 demo agent。
 *
 * 刻意不复用项目里的 chat-model / agent-runner / agent-registry 等抽象，
 * 直接用 LangChain 原语搭建，方便作为独立可执行的演示样例。
 */
export async function runDemoAgent(input: string) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("未配置 OPENAI_API_KEY，请在 .env.local 中补充。");
  }

  const model = new ChatOpenAI({
    apiKey,
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    temperature: 0.3,
    streamUsage: false,
    configuration: process.env.OPENAI_BASE_URL
      ? { baseURL: process.env.OPENAI_BASE_URL }
      : undefined,
  });

  const agent = createAgent({
    model,
    tools: [getCurrentTimeTool],
    systemPrompt:
      "你是一个最小化的中文 demo 助手，需要当前时间时可调用 get_current_time 工具，并用中文简洁回答。",
  });

  const config = {
    configurable: {
      thread_id: crypto.randomUUID(),
    },
  };

  const result = await agent.invoke(
    {
      messages: [{ role: "user", content: input }],
    },
    config,
  );

  const last = result.messages.at(-1);
  const content = last?.content;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : part && typeof part === "object" && "text" in part
            ? String((part as { text?: unknown }).text ?? "")
            : "",
      )
      .join("");
  }

  return "";
}
