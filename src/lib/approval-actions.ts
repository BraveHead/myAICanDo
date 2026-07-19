import type { SupportedAgent } from "@/lib/agent/shared/agent-ids";
import type { FilesystemApprovalPreview } from "@/lib/agent/services/filesystem-service";
import type { MemorySavePreview } from "@/lib/server/memory-store";

export const APPROVAL_GATED_TOOL_NAMES = [
  "save_memory",
  "delete_memory",
  "write_file",
  "edit_file",
  "delete_file",
] as const;

export type ApprovalGatedToolName = (typeof APPROVAL_GATED_TOOL_NAMES)[number];

export type ApprovalActionStatus =
  | "pending"
  | "approved"
  | "executing"
  | "rejected"
  | "executed"
  | "expired"
  | "failed";

export type ApprovalDecision =
  | "approve"
  | "reject"
  | "edit_args"
  | "guidance";

export type ApprovalOption = {
  id: string;
  kind: string;
  label: string;
  description?: string;
};

export type ApprovalToolResult = {
  content: string;
  status: "error" | "success";
};

export type ApprovalPreview = MemorySavePreview | FilesystemApprovalPreview;

export type ApprovalExecutionResponse = {
  approvalId: string;
  approved: boolean;
  decision?: ApprovalDecision;
  followUpMessage?: string;
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
  preview?: MemorySavePreview | FilesystemApprovalPreview;
  toolCallId: string;
  toolName: ApprovalGatedToolName;
};

export function isApprovalGatedToolName(
  toolName: string,
): toolName is ApprovalGatedToolName {
  return APPROVAL_GATED_TOOL_NAMES.some((name) => name === toolName);
}
