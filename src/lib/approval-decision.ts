export type ClientApprovalDecision = {
  approvalId: string;
  approved: boolean;
  optionId?: string;
  reason?: string;
};

export function createApprovalRequestBody({
  approvalDecision,
  threadId,
  workspaceId,
}: {
  approvalDecision: ClientApprovalDecision;
  threadId: string;
  workspaceId: string;
}) {
  const base = {
    approvalId: approvalDecision.approvalId,
    threadId,
    workspaceId,
  };

  if (approvalDecision.optionId === "edit-and-execute") {
    const payload = parseEditArgsPayload(approvalDecision.reason);
    if (!payload) {
      throw new Error("修改后的审批参数无效，请重新编辑。");
    }

    return {
      ...base,
      args: payload.args,
      decision: "edit_args" as const,
    };
  }

  if (approvalDecision.optionId === "provide-guidance") {
    const guidance = approvalDecision.reason?.trim();
    if (!guidance) {
      throw new Error("指导内容不能为空。");
    }

    return {
      ...base,
      decision: "guidance" as const,
      guidance,
    };
  }

  return {
    ...base,
    decision: approvalDecision.approved
      ? ("approve" as const)
      : ("reject" as const),
    ...(approvalDecision.reason ? { reason: approvalDecision.reason } : {}),
  };
}

function parseEditArgsPayload(reason: string | undefined) {
  if (!reason) {
    return null;
  }

  try {
    const payload = JSON.parse(reason) as { args?: unknown; version?: unknown };
    if (payload.version !== 1 || !isPlainRecord(payload.args)) {
      return null;
    }

    return { args: payload.args };
  } catch {
    return null;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
