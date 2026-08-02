import type { ApprovalPendingPayload } from "@/lib/approval-actions";

export class ToolApprovalRequiredError extends Error {
  constructor(
    public readonly pendingAction: ApprovalPendingPayload,
    public readonly userMessage: string,
  ) {
    super(userMessage);
    this.name = "ToolApprovalRequiredError";
  }
}

export function findToolApprovalRequiredError(error: unknown) {
  const visited = new Set<unknown>();
  let current = error;

  while (current instanceof Error && !visited.has(current)) {
    if (current instanceof ToolApprovalRequiredError) {
      return current;
    }

    visited.add(current);
    current = current.cause;
  }

  return null;
}
