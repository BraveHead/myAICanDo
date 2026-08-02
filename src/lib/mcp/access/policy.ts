import type { PendingActionScope } from "@/lib/server/pending-action-store";
import { McpPublicError } from "../core/errors";
import {
  createPostgresMcpAccessRepository,
  type McpAccessRepository,
} from "./repository";

const ACCESSIBLE_TENANT_STATUSES = new Set([
  "active",
  "expiring_soon",
  "trial",
]);

export type McpAccessErrorCode =
  | "invalid_scope"
  | "tenant_expired"
  | "tenant_forbidden"
  | "tenant_not_found"
  | "thread_not_found"
  | "thread_workspace_mismatch"
  | "user_inactive"
  | "user_not_found"
  | "workspace_not_found";

export type McpAccessErrorStatus = 400 | 401 | 403 | 404;

export class McpAccessError extends McpPublicError {
  constructor(
    code: McpAccessErrorCode,
    message: string,
    readonly status: McpAccessErrorStatus,
  ) {
    super(code, message);
    this.name = "McpAccessError";
  }
}

export type McpThreadAccessInput = {
  tenantHashId: string;
  threadId: string;
  userHashId: string;
  workspaceId: string;
};

export type TrustedMcpThreadAccess = {
  scope: PendingActionScope;
  threadId: string;
};

export type McpAccessPolicy = {
  requireThreadAccess(
    input: McpThreadAccessInput,
  ): Promise<TrustedMcpThreadAccess>;
};

export function createMcpAccessPolicy(
  repository: McpAccessRepository = createPostgresMcpAccessRepository(),
): McpAccessPolicy {
  return {
    requireThreadAccess: (input) =>
      requireMcpThreadAccess(input, repository),
  };
}

export async function requireMcpThreadAccess(
  input: McpThreadAccessInput,
  repository: McpAccessRepository = createPostgresMcpAccessRepository(),
): Promise<TrustedMcpThreadAccess> {
  const normalizedInput = normalizeAccessInput(input);
  const user = await repository.findUserByHashId(
    normalizedInput.userHashId,
  );
  if (!user) {
    throw new McpAccessError(
      "user_not_found",
      "用户不存在或已被移除。",
      401,
    );
  }
  if (!user.isActive) {
    throw new McpAccessError("user_inactive", "当前账号已停用。", 403);
  }
  if (!user.joinedTenantHashIds.includes(normalizedInput.tenantHashId)) {
    throw new McpAccessError(
      "tenant_forbidden",
      "当前账号未加入该租户。",
      403,
    );
  }

  const tenant = await repository.findTenantByHashId(
    normalizedInput.tenantHashId,
  );
  if (!tenant) {
    throw new McpAccessError("tenant_not_found", "租户不存在。", 404);
  }
  if (!ACCESSIBLE_TENANT_STATUSES.has(tenant.status)) {
    throw new McpAccessError("tenant_expired", "当前租户已过期。", 403);
  }

  const workspace = await repository.findWorkspaceById(
    normalizedInput.workspaceId,
  );
  if (
    !workspace ||
    workspace.status !== "active" ||
    workspace.tenantHashId !== normalizedInput.tenantHashId
  ) {
    throw new McpAccessError(
      "workspace_not_found",
      "工作区不存在或不属于当前租户。",
      404,
    );
  }

  const thread = await repository.findThreadByScope({
    tenantHashId: normalizedInput.tenantHashId,
    threadId: normalizedInput.threadId,
    userHashId: normalizedInput.userHashId,
  });
  if (!thread?.workspaceId) {
    throw new McpAccessError(
      "thread_not_found",
      "线程不存在或未绑定工作区。",
      404,
    );
  }
  if (thread.workspaceId !== normalizedInput.workspaceId) {
    throw new McpAccessError(
      "thread_workspace_mismatch",
      "线程不属于当前工作区。",
      403,
    );
  }

  return {
    scope: {
      tenantHashId: normalizedInput.tenantHashId,
      userHashId: normalizedInput.userHashId,
      workspaceId: normalizedInput.workspaceId,
    },
    threadId: normalizedInput.threadId,
  };
}

function normalizeAccessInput(
  input: McpThreadAccessInput,
): McpThreadAccessInput {
  const normalizedInput = {
    tenantHashId: input.tenantHashId.trim(),
    threadId: input.threadId.trim(),
    userHashId: input.userHashId.trim(),
    workspaceId: input.workspaceId.trim(),
  };

  if (Object.values(normalizedInput).some((value) => !value)) {
    throw new McpAccessError(
      "invalid_scope",
      "MCP 访问作用域参数不能为空。",
      400,
    );
  }

  return normalizedInput;
}
