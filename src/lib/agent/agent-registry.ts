import {
  isSupportedAgent,
  supportedAgentIds,
  type SupportedAgent,
} from "./agent-ids";
import type { AgentDefinition, AgentMessage } from "./agent-definition";
import { literaryAgentDefinition } from "./literary-agent";
import { weatherAgentDefinition } from "./weather-agent";

const agentDefinitions = {
  weather: weatherAgentDefinition,
  literary: literaryAgentDefinition,
} satisfies Record<SupportedAgent, AgentDefinition>;

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
