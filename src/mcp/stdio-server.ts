import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { fileURLToPath } from "node:url";
import { loadMcpServerConfig } from "@/lib/mcp/config";
import { logMcpError } from "@/lib/mcp/core/observability";
import { createDefaultMcpServer } from "@/lib/mcp/default-server";
import {
  closePostgresPool,
  getPostgresPool,
} from "@/lib/server/postgres-runtime";

let handle: StdioServerHandle | null = null;
let shuttingDown = false;

try {
  const config = loadMcpServerConfig();
  if (!process.env.FILESYSTEM_SANDBOX_ROOT?.trim()) {
    process.env.FILESYSTEM_SANDBOX_ROOT = fileURLToPath(
      new URL("../../var/agent-files", import.meta.url),
    );
  }
  await getPostgresPool().query("SELECT 1");

  handle = serveStdio(() => createDefaultMcpServer(config), {
    legacy: "serve",
    onerror(error) {
      logMcpError({
        error,
        requestId: crypto.randomUUID(),
        toolName: "stdio_transport",
      });
    },
  });

  process.stderr.write(
    `${JSON.stringify({
      component: "mcp-server",
      level: "info",
      message: "MCP stdio server started",
      serverName: config.metadata.name,
      serverVersion: config.metadata.version,
      timestamp: new Date().toISOString(),
    })}\n`,
  );
} catch (error) {
  writeStartupError(error);
  await closePostgresPool().catch(writeStartupError);
  process.exitCode = 1;
}

if (handle) {
  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.stdin.once("end", () => {
    void shutdown("stdin_end");
  });
}

async function shutdown(reason: string) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  process.stderr.write(
    `${JSON.stringify({
      component: "mcp-server",
      level: "info",
      message: "MCP stdio server stopping",
      reason,
      timestamp: new Date().toISOString(),
    })}\n`,
  );

  try {
    await handle?.close();
  } catch (error) {
    logMcpError({
      error,
      requestId: crypto.randomUUID(),
      toolName: "stdio_shutdown",
    });
  } finally {
    await closePostgresPool().catch((error) => {
      logMcpError({
        error,
        requestId: crypto.randomUUID(),
        toolName: "postgres_shutdown",
      });
    });
    process.stdin.pause();
  }
}

function writeStartupError(error: unknown) {
  const normalizedError =
    error instanceof Error
      ? {
          message: error.message,
          name: error.name,
        }
      : {
          message: String(error),
          name: typeof error,
        };

  process.stderr.write(
    `${JSON.stringify({
      component: "mcp-server",
      error: normalizedError,
      level: "error",
      message: "MCP stdio server failed to start",
      timestamp: new Date().toISOString(),
    })}\n`,
  );
}
