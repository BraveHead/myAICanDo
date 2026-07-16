import { ChatOpenAI } from "@langchain/openai";

const FALLBACK_MODEL_TIMEOUT = 10 * 60 * 1000;
const MODEL_TIMEOUT_ENV = "OPENAI_MODEL_TIMEOUT_MS";

export const DEFAULT_MODEL_TIMEOUT = parseModelTimeout(
  process.env[MODEL_TIMEOUT_ENV],
  FALLBACK_MODEL_TIMEOUT,
);

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
    model: `${modelName}`,
    temperature,
    timeout: timeout ?? DEFAULT_MODEL_TIMEOUT,
    streamUsage: false,
    configuration: baseURL ? { baseURL } : undefined,
  });
}

function parseModelTimeout(value: string | undefined, fallback: number) {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsedValue = Number(value);
  return Number.isFinite(parsedValue) && parsedValue > 0
    ? Math.round(parsedValue)
    : fallback;
}
