import { toolStrategy } from "langchain";
import * as z from "zod";

const structuredAgentResponseSchema = z.object({
  answer: z.string().describe("最终展示给用户的自然语言回答。"),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .default(0.8)
    .describe("答案可信度，范围为 0 到 1。"),
  keyFacts: z
    .array(z.string())
    .default([])
    .describe("支撑答案的关键事实或依据。"),
  toolResults: z
    .array(
      z.object({
        summary: z.string().describe("工具结果摘要。"),
        toolName: z.string().describe("被调用的工具名称。"),
      }),
    )
    .default([])
    .describe("使用到的工具及其结果摘要。"),
});

export const structuredAgentResponseFormat = toolStrategy(
  structuredAgentResponseSchema,
  {
    toolMessageContent: "结构化响应已生成。",
  },
);
