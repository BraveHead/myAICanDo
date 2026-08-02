import type { CallToolResult } from "@modelcontextprotocol/server";
import type { McpAccessPolicy } from "../access/policy";
import type { McpServerIdentity } from "../config";
import { parseMcpThreadScopeInput } from "../contracts/common";
import { McpPublicError } from "./errors";
import type { McpLogger } from "./observability";
import type { McpToolDefinition } from "./tool-definition";
import { createMcpToolError, createMcpToolResult } from "./tool-result";

export type McpToolRuntime = {
  accessPolicy: McpAccessPolicy;
  identity: McpServerIdentity;
  logger: McpLogger;
};

export async function executeMcpTool(
  definition: McpToolDefinition,
  input: unknown,
  runtime: McpToolRuntime,
): Promise<CallToolResult> {
  const requestId = crypto.randomUUID();
  const startedAt = performance.now();

  try {
    const trustedScope = await authorizeToolCall(definition, input, runtime);
    const result = createMcpToolResult(
      await definition.execute(input, { requestId, trustedScope }),
    );
    runtime.logger.logInvocation({
      durationMs: elapsedMilliseconds(startedAt),
      isError: false,
      requestId,
      toolName: definition.name,
    });
    return result;
  } catch (error) {
    const durationMs = elapsedMilliseconds(startedAt);
    if (error instanceof McpPublicError) {
      const result = createMcpToolResult(
        createMcpToolError(error.code, error.message, requestId),
        true,
      );
      runtime.logger.logInvocation({
        durationMs,
        isError: true,
        requestId,
        toolName: definition.name,
      });
      return result;
    }

    runtime.logger.logInternalError({
      durationMs,
      error,
      requestId,
      toolName: definition.name,
    });
    runtime.logger.logInvocation({
      durationMs,
      isError: true,
      requestId,
      toolName: definition.name,
    });
    return createMcpToolResult(
      createMcpToolError(
        "internal_error",
        "MCP 工具执行失败，请根据 requestId 查看服务端日志。",
        requestId,
      ),
      true,
    );
  }
}

async function authorizeToolCall(
  definition: McpToolDefinition,
  input: unknown,
  runtime: McpToolRuntime,
) {
  switch (definition.access.kind) {
    case "thread": {
      const scopeInput = parseMcpThreadScopeInput(input);
      if (!scopeInput) {
        throw new McpPublicError(
          "invalid_scope",
          "MCP 访问作用域参数不能为空。",
        );
      }
      return runtime.accessPolicy.requireThreadAccess({
        ...scopeInput,
        tenantHashId: runtime.identity.tenantHashId,
        userHashId: runtime.identity.userHashId,
      });
    }
  }
}

function elapsedMilliseconds(startedAt: number) {
  return Math.round(performance.now() - startedAt);
}
