export const supportedAgentIds = [
  "coordinator",
  "weather",
  "literary",
  "filesystem",
  "memory",
  "demo",
] as const;

export type SupportedAgent = (typeof supportedAgentIds)[number];

export function isSupportedAgent(agent: unknown): agent is SupportedAgent {
  return supportedAgentIds.some((supportedAgent) => supportedAgent === agent);
}
