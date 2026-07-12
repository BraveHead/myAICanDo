import type { SupportedAgent } from "@/lib/agent/shared/agent-ids";

export const APPROVAL_GATED_TOOL_NAMES = [
  "save_memory",
  "delete_memory",
] as const;

export type ApprovalGatedToolName = (typeof APPROVAL_GATED_TOOL_NAMES)[number];

export type ApprovalActionStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "executed"
  | "expired"
  | "failed";

export type ApprovalToolResult = {
  content: string;
  status: "error" | "success";
};

export type ApprovalExecutionResponse = {
  approvalId: string;
  approved: boolean;
  finalText: string;
  isError: boolean;
  ok: boolean;
  status: ApprovalActionStatus;
  structuredResponse: {
    answer: string;
    confidence: number;
    keyFacts: string[];
    toolResults: Array<{
      summary: string;
      toolName: string;
    }>;
  };
  toolCallId: string;
  toolName: ApprovalGatedToolName;
  toolResult: ApprovalToolResult;
};

export type ApprovalPendingPayload = {
  actionId: string;
  agentId: SupportedAgent;
  args: unknown;
  toolCallId: string;
  toolName: ApprovalGatedToolName;
};

export function isApprovalGatedToolName(
  toolName: string,
): toolName is ApprovalGatedToolName {
  return APPROVAL_GATED_TOOL_NAMES.some((name) => name === toolName);
}
