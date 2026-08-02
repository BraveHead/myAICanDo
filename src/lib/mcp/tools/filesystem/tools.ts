import {
  defineMcpTool,
  readonlyToolAnnotations,
  type McpToolDefinition,
} from "../../core/tool-definition";
import {
  defaultFilesystemMcpPort,
  listFiles,
  readFile,
  type FilesystemMcpPort,
} from "./adapter";
import {
  listWorkspaceFilesInputSchema,
  listWorkspaceFilesOutputSchema,
  readWorkspaceFileInputSchema,
  readWorkspaceFileOutputSchema,
} from "./contracts";

export function createFilesystemMcpTools(
  port: FilesystemMcpPort = defaultFilesystemMcpPort,
): McpToolDefinition[] {
  return [
    defineMcpTool({
      access: { kind: "thread" },
      annotations: {
        ...readonlyToolAnnotations,
        title: "列出工作区文件",
      },
      description:
        "列出当前已授权线程沙盒内的目录。只能使用相对路径，不递归列出，也不会创建或修改文件。",
      execute: async (input, { trustedScope }) =>
        listFiles(trustedScope, input.path, port),
      inputSchema: listWorkspaceFilesInputSchema,
      name: "list_workspace_files",
      outputSchema: listWorkspaceFilesOutputSchema,
      title: "列出工作区文件",
    }),
    defineMcpTool({
      access: { kind: "thread" },
      annotations: {
        ...readonlyToolAnnotations,
        title: "读取工作区文件",
      },
      description:
        "读取当前已授权线程沙盒中的 UTF-8 文本文件。拒绝绝对路径、路径逃逸、符号链接、二进制文件和超限文件。",
      execute: async (input, { trustedScope }) =>
        readFile(trustedScope, input.path, port),
      inputSchema: readWorkspaceFileInputSchema,
      name: "read_workspace_file",
      outputSchema: readWorkspaceFileOutputSchema,
      title: "读取工作区文件",
    }),
  ];
}
