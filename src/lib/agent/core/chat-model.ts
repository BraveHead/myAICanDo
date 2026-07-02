import { ChatOpenAI } from "@langchain/openai";

export const DEFAULT_MODEL_TIMEOUT = 60_000;

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
    timeout: timeout ?? DEFAULT_MODEL_TIMEOUT,
    streamUsage: false,
    configuration: baseURL ? { baseURL } : undefined,
  });
}
