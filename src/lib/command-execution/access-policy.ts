export type CommandExecutionThreadAccessError = {
  code: "thread_not_found" | "thread_workspace_mismatch";
  message: string;
  status: 403 | 404;
};

export function getCommandExecutionThreadAccessError({
  allowUnpersistedThread = false,
  requestedWorkspaceId,
  storedWorkspaceId,
}: {
  allowUnpersistedThread?: boolean;
  requestedWorkspaceId: string;
  storedWorkspaceId: string | null;
}): CommandExecutionThreadAccessError | null {
  if (!storedWorkspaceId) {
    return allowUnpersistedThread
      ? null
      : {
          code: "thread_not_found",
          message: "线程不存在或未绑定工作区。",
          status: 404,
        };
  }

  if (storedWorkspaceId !== requestedWorkspaceId) {
    return {
      code: "thread_workspace_mismatch",
      message: "命令执行请求不能跨工作区访问。",
      status: 403,
    };
  }

  return null;
}
