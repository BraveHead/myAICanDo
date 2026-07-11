import { createCoordinatorTools } from "../../tools";
import type { AgentDefinition } from "../core/agent-definition";
import { structuredAgentResponseFormat } from "../shared/response-format";

/*
 * Coordinator Agent 后续迭代路线：
 * v1.1：增加委派决策日志与统计，记录调用了哪些子能力、耗时和结果状态。
 * v1.2：支持“建议保存记忆”候选，但必须用户确认后再交给 Memory agent 写入。
 * v1.3：让 coordinator 支持更多只读 agent 能力，例如 literary/demo 任务分派。
 * v1.4：升级为真正的 agent-to-agent runner，但要隔离 checkpointer，防止递归和重复上下文。
 * v1.5：加入 human-in-the-loop，对高风险工具调用先请求用户确认。
 * v1.6：对长任务引入后台任务/队列，避免单次 SSE 请求承担过长流程。
 */

const SYSTEM_PROMPT = `你是一个 coordinator agent，负责把用户的复合任务拆解给白名单委派工具，并汇总结果。

## 可委派能力

- ask_memory_agent：只读查询当前租户和用户的长期记忆。
- ask_filesystem_agent：只读访问当前线程 filesystem 沙盒，支持 list/read/search。
- ask_weather_agent：查询指定城市天气。

## 规则

- 只能通过委派工具获取 memory、filesystem、weather 信息，不要编造工具没有返回的事实。
- v1 不能保存、删除或修改长期记忆；如果用户要求“记住、保存、删除、忘记”，说明 coordinator v1 不执行写操作，并建议使用 Memory agent 显式处理。
- filesystem 只允许只读访问相对路径；不要要求或尝试访问绝对路径、上级目录或项目仓库目录。
- 对复合任务，先调用必要的委派工具，再把结果合并成一个简洁回答。
- 如果某个委派工具返回错误，说明错误原因，并继续汇总其它可用结果。
- 默认用中文回答，除非用户当前请求或已查询到的记忆明确要求其它语言。
- 最终回答必须包含关键依据，不要只说“已完成”。`;

export const coordinatorAgentDefinition = {
  id: "coordinator",
  systemPrompt: SYSTEM_PROMPT,
  tools: ({ threadId, threadScope }) =>
    createCoordinatorTools({
      threadId,
      threadScope,
    }),
  modelOptions: {
    temperature: 0.2,
  },
  responseFormat: structuredAgentResponseFormat,
  recursionLimit: 8,
} satisfies AgentDefinition;
