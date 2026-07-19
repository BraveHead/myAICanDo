import { describe, expect, test } from "bun:test";

const { createApprovalRequestBody } = await import(
  "../src/lib/approval-decision.ts"
);

const base = {
  threadId: "thread_a",
  workspaceId: "ws_a",
};

describe("M7 approval decision protocol", () => {
  test("keeps approve and reject decisions scoped", () => {
    expect(
      createApprovalRequestBody({
        ...base,
        approvalDecision: {
          approvalId: "approval_a",
          approved: true,
          optionId: "approve-once",
        },
      }),
    ).toEqual({
      approvalId: "approval_a",
      decision: "approve",
      threadId: "thread_a",
      workspaceId: "ws_a",
    });

    expect(
      createApprovalRequestBody({
        ...base,
        approvalDecision: {
          approvalId: "approval_a",
          approved: false,
          optionId: "reject-once",
          reason: "用户取消",
        },
      }),
    ).toMatchObject({
      approvalId: "approval_a",
      decision: "reject",
      reason: "用户取消",
    });
  });

  test("encodes edited args as a versioned payload", () => {
    expect(
      createApprovalRequestBody({
        ...base,
        approvalDecision: {
          approvalId: "approval_a",
          approved: true,
          optionId: "edit-and-execute",
          reason: JSON.stringify({
            args: { content: "new", path: "workspace/report.md" },
            version: 1,
          }),
        },
      }),
    ).toEqual({
      approvalId: "approval_a",
      args: { content: "new", path: "workspace/report.md" },
      decision: "edit_args",
      threadId: "thread_a",
      workspaceId: "ws_a",
    });
  });

  test("encodes guidance and rejects empty guidance", () => {
    expect(
      createApprovalRequestBody({
        ...base,
        approvalDecision: {
          approvalId: "approval_a",
          approved: false,
          optionId: "provide-guidance",
          reason: "先创建备份，不要删除原文件。",
        },
      }),
    ).toMatchObject({
      decision: "guidance",
      guidance: "先创建备份，不要删除原文件。",
    });

    expect(() =>
      createApprovalRequestBody({
        ...base,
        approvalDecision: {
          approvalId: "approval_a",
          approved: false,
          optionId: "provide-guidance",
          reason: "   ",
        },
      }),
    ).toThrow("指导内容不能为空");
  });
});
