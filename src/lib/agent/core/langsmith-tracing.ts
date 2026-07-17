import type { RunnableConfig } from "@langchain/core/runnables";
import type { SupportedAgent } from "../shared/agent-ids";

const LANGSMITH_PROJECT_NAME = "my-ai-can-do";
const LANGSMITH_PROJECT_ID = "9bb59f56-9f40-4464-b334-df27bf57cc6c";
const LANGSMITH_ORGANIZATION_ID =
  "3b483e76-04e7-4d2c-98b4-ffa5ecb23e6e";
const LANGSMITH_WORKSPACE_ID = LANGSMITH_ORGANIZATION_ID;
const LANGSMITH_ENDPOINT = "https://api.smith.langchain.com";
const LANGSMITH_PROJECT_URL = `https://smith.langchain.com/o/${LANGSMITH_ORGANIZATION_ID}/projects/p/${LANGSMITH_PROJECT_ID}`;

type CreateLangSmithRunConfigOptions = {
  agent?: SupportedAgent;
  modelName: string;
  route?: string;
  tenantHashId?: string;
  threadId?: string;
  userHashId?: string;
  workspaceId?: string;
};

function ensureLangSmithTracingEnv() {
  if (!process.env.LANGSMITH_API_KEY) {
    return false;
  }

  process.env.LANGSMITH_TRACING ||= "true";
  process.env.LANGSMITH_ENDPOINT ||= LANGSMITH_ENDPOINT;
  process.env.LANGSMITH_PROJECT ||= LANGSMITH_PROJECT_NAME;
  process.env.LANGSMITH_WORKSPACE_ID ||= LANGSMITH_WORKSPACE_ID;

  return process.env.LANGSMITH_TRACING === "true";
}

export function createLangSmithRunConfig({
  agent,
  modelName,
  route = "/api/tenants/[tenantId]/chat",
  tenantHashId,
  threadId,
  userHashId,
  workspaceId,
}: CreateLangSmithRunConfigOptions): RunnableConfig {
  const tracingEnabled = ensureLangSmithTracingEnv();
  const resolvedAgent = agent ?? "default";

  return {
    runName: `chat:${resolvedAgent}`,
    tags: [
      "app:my-ai-can-do",
      `agent:${resolvedAgent}`,
      `model:${modelName}`,
      tracingEnabled ? "langsmith:enabled" : "langsmith:disabled",
    ],
    metadata: {
      app: "my-ai-can-do",
      agent: resolvedAgent,
      model: modelName,
      route,
      tenant_hash_id: tenantHashId || undefined,
      thread_id: threadId || undefined,
      user_hash_id: userHashId || undefined,
      product_workspace_id: workspaceId || undefined,
      langsmith_project: process.env.LANGSMITH_PROJECT || LANGSMITH_PROJECT_NAME,
      langsmith_project_id: LANGSMITH_PROJECT_ID,
      langsmith_project_url: LANGSMITH_PROJECT_URL,
      langsmith_workspace_id: LANGSMITH_WORKSPACE_ID,
    },
  };
}
