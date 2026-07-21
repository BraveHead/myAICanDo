import { createCoordinatorTools, createExecuteCommandTool } from "../../tools";
import type { AgentDefinition } from "../core/agent-definition";
import { structuredAgentResponseFormat } from "../shared/response-format";

/*
 * Coordinator Agent 后续迭代路线：
 * v1.1：增加委派决策日志与统计，记录调用了哪些子能力、耗时和结果状态。
 * v1.2：支持更细的“建议保存记忆”候选审核，允许用户编辑候选内容后再确认。
 * v1.3：让 coordinator 支持更多只读 agent 能力，例如 literary/demo 任务分派。
 * v1.4：升级为真正的 agent-to-agent runner，但要隔离 checkpointer，防止递归和重复上下文。
 * v1.5：把 human-in-the-loop 扩展到更多高风险工具调用，例如外部 API、写文件、子任务执行。
 * v1.6：对长任务引入后台任务/队列，避免单次 SSE 请求承担过长流程。
 * M9：execute_command 只允许在当前 thread sandbox 中执行受限只读命令，并且必须经过确认。
 */

const SYSTEM_PROMPT = `你是一个 coordinator agent，负责把用户的复合任务拆解给白名单委派工具，并汇总结果。

## 可委派能力

- task：优先使用的真正 subagent 委派工具。可启动隔离的 filesystem、memory、weather 子 agent，并只返回每个子任务的 final report。
- ask_memory_agent：只读查询当前租户和用户的长期记忆。
- save_memory：发起“保存长期记忆”的确认请求，只有用户确认后才会真正写入。
- delete_memory：发起“删除长期记忆”的确认请求，只有用户确认后才会真正删除。
- ask_filesystem_agent：只读访问当前线程 filesystem 沙盒，支持 list/read/search。
- ask_weather_agent：查询指定城市天气。
- execute_command：在当前 thread sandbox 中执行受 allowlist 限制的只读命令，需要用户确认。

## 规则

- 对复合任务，优先调用 task，把“查记忆、搜文件、查天气”等子任务拆给对应 subagent；只有简单单步查询或兼容旧流程时才使用 ask_*_agent。
- task 返回的是子 agent final report；父上下文不要要求或展开子 agent 的完整内部消息。
- 只能通过委派工具获取 memory、filesystem、weather 信息，不要编造工具没有返回的事实。
- 如果用户明确要求“记住、保存、删除、忘记”，可以调用 save_memory/delete_memory 发起确认；在用户确认前，不要声称已经写入或删除。
- 除 save_memory/delete_memory 的确认流外，不能修改长期记忆。
- filesystem 只允许只读访问相对路径；不要要求或尝试访问绝对路径、上级目录或项目仓库目录。
- execute_command 只能执行安全 allowlist 中的命令；不要使用 shell、管道、重定向、网络命令或访问 sandbox 外路径。
- execute_command 在用户确认前不要声称命令已经执行；执行结果只代表当前 thread sandbox 内的结果。
- 对复合任务，先调用必要的委派工具，再把结果合并成一个简洁回答。
- 如果某个委派工具返回错误，说明错误原因，并继续汇总其它可用结果。
- 默认用中文回答，除非用户当前请求或已查询到的记忆明确要求其它语言。
- 最终回答必须包含关键依据，不要只说“已完成”。`;

export const coordinatorAgentDefinition = {
  id: "coordinator",
  systemPrompt: SYSTEM_PROMPT,
  tools: (context) => [
    ...createCoordinatorTools(context),
    ...(context.threadId && context.threadScope
      ? [
          createExecuteCommandTool({
            threadId: context.threadId,
            threadScope: context.threadScope,
          }),
        ]
      : []),
  ],
  modelOptions: {
    temperature: 0.2,
  },
  responseFormat: structuredAgentResponseFormat,
  recursionLimit: 8,
} satisfies AgentDefinition;
