export const supportedAgentIds = [
  "weather",
  "literary",
  "filesystem",
  "demo",
] as const;

export type SupportedAgent = (typeof supportedAgentIds)[number];

export function isSupportedAgent(agent: unknown): agent is SupportedAgent {
  return supportedAgentIds.some((supportedAgent) => supportedAgent === agent);
}
