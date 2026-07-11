import {
  isSupportedAgent,
  supportedAgentIds,
  type SupportedAgent,
} from "../shared/agent-ids";
import type { AgentDefinition, AgentMessage } from "./agent-definition";
import { coordinatorAgentDefinition } from "../definitions/coordinator";
import { demoAgentDefinition } from "../definitions/demo";
import { filesystemAgentDefinition } from "../definitions/filesystem";
import { literaryAgentDefinition } from "../definitions/literary";
import { memoryAgentDefinition } from "../definitions/memory";
import { weatherAgentDefinition } from "../definitions/weather";

const agentDefinitions: Record<SupportedAgent, AgentDefinition> = {
  coordinator: coordinatorAgentDefinition,
  weather: weatherAgentDefinition,
  literary: literaryAgentDefinition,
  filesystem: filesystemAgentDefinition,
  memory: memoryAgentDefinition,
  demo: demoAgentDefinition,
};

export function getAgentDefinition(agent: unknown) {
  if (!isSupportedAgent(agent)) {
    return undefined;
  }

  return agentDefinitions[agent];
}

export function resolveAgentDefinition({
  agent,
  messages,
}: {
  agent: unknown;
  messages: AgentMessage[];
}) {
  const requestedDefinition = getAgentDefinition(agent);
  if (requestedDefinition) {
    return requestedDefinition;
  }

  const content = messages.at(-1)?.content.trim() ?? "";

  return supportedAgentIds
    .map((agentId) => agentDefinitions[agentId])
    .find((definition) => definition.match?.(content));
}
