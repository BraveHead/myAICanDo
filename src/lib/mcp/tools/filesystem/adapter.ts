import {
  listFilesystemDirectory,
  readFilesystemFile,
} from "@/lib/agent/services/filesystem-service";
import type { TrustedMcpThreadAccess } from "../../access/policy";
import { McpPublicError } from "../../core/errors";

export type FilesystemMcpPort = {
  listFilesystemDirectory: typeof listFilesystemDirectory;
  readFilesystemFile: typeof readFilesystemFile;
};

export const defaultFilesystemMcpPort: FilesystemMcpPort = {
  listFilesystemDirectory,
  readFilesystemFile,
};

export async function listFiles(
  trustedScope: TrustedMcpThreadAccess,
  path: string,
  port: FilesystemMcpPort,
) {
  const result = await port.listFilesystemDirectory(
    createFilesystemContext(trustedScope),
    path,
  );
  if (!result.ok) {
    throw new McpPublicError(result.error.code, result.error.message);
  }
  return result;
}

export async function readFile(
  trustedScope: TrustedMcpThreadAccess,
  path: string,
  port: FilesystemMcpPort,
) {
  const result = await port.readFilesystemFile(
    createFilesystemContext(trustedScope),
    path,
  );
  if (!result.ok) {
    throw new McpPublicError(result.error.code, result.error.message);
  }
  return result;
}

function createFilesystemContext(
  trustedScope: TrustedMcpThreadAccess,
) {
  return {
    threadId: trustedScope.threadId,
    threadScope: {
      tenantHashId: trustedScope.scope.tenantHashId,
      userHashId: trustedScope.scope.userHashId,
      workspaceId: trustedScope.scope.workspaceId,
    },
  };
}
