import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createDefaultMcpServer } from "../../src/lib/mcp/default-server";

const config = {
  identity: {
    tenantHashId: "tenant_fixture",
    userHashId: "user_fixture",
  },
  metadata: {
    instructions: "fixture",
    name: "my-ai-can-do-mcp" as const,
    title: "MCP fixture",
    version: "0.1.0-test",
  },
};

const accessPolicy = {
  async requireThreadAccess(input: {
    tenantHashId: string;
    threadId: string;
    userHashId: string;
    workspaceId: string;
  }) {
    return {
      scope: {
        tenantHashId: input.tenantHashId,
        userHashId: input.userHashId,
        workspaceId: input.workspaceId,
      },
      threadId: input.threadId,
    };
  },
};

const commandExecution = {
  async getCommandExecution() {
    return null;
  },
  async listCommandExecutions() {
    return [];
  },
};

const filesystem = {
  async listFilesystemDirectory(
    _context: unknown,
    path = ".",
  ) {
    return {
      entries: [],
      ok: true as const,
      path,
      summary: "目录为空。",
      truncated: false,
    };
  },
  async readFilesystemFile(_context: unknown, path: string) {
    return {
      content: "fixture",
      ok: true as const,
      path,
      sizeBytes: 7,
      summary: "已读取文件。",
    };
  },
};

const handle = serveStdio(
  () =>
    createDefaultMcpServer(config, {
      accessPolicy,
      commandExecution,
      filesystem,
    }),
  {
    legacy: "serve",
  },
);

process.stderr.write(
  `${JSON.stringify({
    component: "mcp-stdio-fixture",
    level: "info",
    message: "MCP stdio fixture started",
  })}\n`,
);

let closing = false;

process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});
process.stdin.once("end", () => {
  void shutdown();
});

async function shutdown() {
  if (closing) {
    return;
  }
  closing = true;
  await handle.close();
}
