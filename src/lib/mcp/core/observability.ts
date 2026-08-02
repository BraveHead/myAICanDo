export type McpInternalErrorLog = {
  durationMs?: number;
  error: unknown;
  requestId: string;
  toolName: string;
};

export type McpInvocationLog = {
  durationMs: number;
  isError: boolean;
  requestId: string;
  toolName: string;
};

export type McpLogger = {
  logInternalError(input: McpInternalErrorLog): void;
  logInvocation(input: McpInvocationLog): void;
};

export const defaultMcpLogger: McpLogger = {
  logInternalError: logMcpError,
  logInvocation: logMcpInvocation,
};

export function logMcpError({
  durationMs,
  error,
  requestId,
  toolName,
}: McpInternalErrorLog) {
  const normalizedError =
    error instanceof Error
      ? {
          message: error.message,
          name: error.name,
          stack: error.stack,
        }
      : {
          message: String(error),
          name: typeof error,
        };

  process.stderr.write(
    `${JSON.stringify({
      component: "mcp-server",
      durationMs,
      error: normalizedError,
      level: "error",
      requestId,
      timestamp: new Date().toISOString(),
      toolName,
    })}\n`,
  );
}

export function logMcpInvocation({
  durationMs,
  isError,
  requestId,
  toolName,
}: McpInvocationLog) {
  process.stderr.write(
    `${JSON.stringify({
      component: "mcp-server",
      durationMs,
      level: isError ? "warn" : "info",
      requestId,
      status: isError ? "failed" : "completed",
      timestamp: new Date().toISOString(),
      toolName,
    })}\n`,
  );
}
