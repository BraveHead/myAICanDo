import type { CallToolResult } from "@modelcontextprotocol/server";
import type { McpToolError } from "../contracts/common";

export function createMcpToolResult(
  structuredContent: Record<string, unknown>,
  isError = false,
): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(structuredContent),
      },
    ],
    structuredContent,
    ...(isError ? { isError: true } : {}),
  };
}

export function createMcpToolError(
  code: string,
  message: string,
  requestId: string,
): McpToolError {
  return {
    error: {
      code,
      message,
      requestId,
    },
    ok: false,
  };
}
