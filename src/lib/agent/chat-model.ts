import { ChatOpenAI } from "@langchain/openai";

export type CreateProjectChatModelOptions = {
  apiKey: string;
  baseURL?: string;
  modelName: string;
  temperature?: number;
  timeout?: number;
};

export function createProjectChatModel({
  apiKey,
  baseURL,
  modelName,
  temperature = 0.3,
  timeout,
}: CreateProjectChatModelOptions) {
  return new ChatOpenAI({
    apiKey,
    model: modelName,
    temperature,
    timeout,
    streamUsage: false,
    configuration: baseURL ? { baseURL } : undefined,
  });
}
