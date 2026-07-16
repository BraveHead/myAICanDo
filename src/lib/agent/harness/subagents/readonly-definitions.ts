import {
  createMemoryReadTools,
  createReadonlyFilesystemTools,
  getWeatherTool,
} from "@/lib/tools";
import type { AgentDefinition } from "../../core/agent-definition";
import { structuredAgentResponseFormat } from "../../shared/response-format";
import type { SubagentId } from "./types";

const FILESYSTEM_SUBAGENT_PROMPT = `你是一个只读 filesystem subagent，负责在当前线程沙盒内完成单个文件系统子任务。

## 能力

- list_filesystem_directory：列出当前线程沙盒中的相对目录。
- read_filesystem_file：读取当前线程沙盒中的 UTF-8 文本文件。
- search_filesystem_text：在当前线程沙盒中递归搜索文本。
- glob_files：按相对 glob 查找文件，支持 *、?、**。

## 规则

- 只能读取当前线程沙盒，不能写入、编辑或删除文件。
- 所有路径都必须是相对路径；不要访问绝对路径、上级目录或项目仓库目录。
- 只基于工具返回的结果输出 final report。
- 输出必须是中文，包含结论和关键依据。`;

const MEMORY_SUBAGENT_PROMPT = `你是一个只读 memory subagent，负责查询当前租户和用户的长期记忆。

## 能力

- list_memories：列出或搜索当前租户和用户下已经保存的长期记忆。

## 规则

- 只能查询记忆，不能保存或删除记忆。
- 只基于工具返回的结果输出 final report。
- 输出必须是中文，包含结论和关键依据。`;

const WEATHER_SUBAGENT_PROMPT = `你是一个 weather subagent，负责完成单个天气查询子任务。

## 能力

- get_weather：查询指定城市天气。

## 规则

- 遇到天气查询时调用 get_weather。
- 只基于工具返回的结果输出 final report。
- 输出必须是中文，包含结论和关键依据。`;

export function getReadonlySubagentDefinition(agent: SubagentId) {
  return readonlySubagentDefinitions[agent];
}

const readonlySubagentDefinitions = {
  filesystem: {
    id: "filesystem",
    systemPrompt: FILESYSTEM_SUBAGENT_PROMPT,
    tools: ({ threadId, threadScope }) =>
      createReadonlyFilesystemTools({
        threadId,
        threadScope,
      }),
    modelOptions: {
      temperature: 0.2,
    },
    responseFormat: structuredAgentResponseFormat,
    recursionLimit: 6,
  },
  memory: {
    id: "memory",
    systemPrompt: MEMORY_SUBAGENT_PROMPT,
    tools: ({ threadId, threadScope }) =>
      createMemoryReadTools({
        threadId,
        threadScope,
      }),
    modelOptions: {
      temperature: 0.2,
    },
    responseFormat: structuredAgentResponseFormat,
    recursionLimit: 6,
  },
  weather: {
    id: "weather",
    systemPrompt: WEATHER_SUBAGENT_PROMPT,
    tools: [getWeatherTool],
    modelOptions: {
      temperature: 0.2,
    },
    responseFormat: structuredAgentResponseFormat,
    recursionLimit: 6,
  },
} satisfies Record<SubagentId, AgentDefinition>;
