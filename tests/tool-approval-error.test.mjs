import { describe, expect, test } from "bun:test";
import { MiddlewareError } from "langchain";
import {
  findToolApprovalRequiredError,
  ToolApprovalRequiredError,
} from "../src/lib/agent/core/tool-approval-error.ts";

const pendingAction = {
  actionId: "approval_1",
  agentId: "filesystem",
  args: { command: "pwd", cwd: "workspace" },
  toolCallId: "tool_1",
  toolName: "execute_command",
};

describe("tool approval error", () => {
  test("finds approval errors wrapped by LangChain middleware", () => {
    const approvalError = new ToolApprovalRequiredError(
      pendingAction,
      "需要你确认后才会执行命令。",
    );
    const wrapped = MiddlewareError.wrap(
      MiddlewareError.wrap(approvalError, "inner"),
      "outer",
    );

    expect(findToolApprovalRequiredError(wrapped)).toBe(approvalError);
  });

  test("ignores unrelated errors and cyclic causes", () => {
    const unrelated = new Error("boom");
    unrelated.cause = unrelated;

    expect(findToolApprovalRequiredError(unrelated)).toBeNull();
  });
});
