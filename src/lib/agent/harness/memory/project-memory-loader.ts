import "server-only";

import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

const MAX_PROJECT_MEMORY_BYTES = 64 * 1024;

export type ProjectMemory = {
  content: string;
  path: string;
  updatedAt: string;
};

export async function loadWorkspaceProjectMemory({
  tenantHashId,
  workspaceId,
}: {
  tenantHashId: string;
  workspaceId: string;
}): Promise<ProjectMemory | null> {
  if (!isSafePathSegment(tenantHashId) || !isSafePathSegment(workspaceId)) {
    return null;
  }

  const root = getFilesystemSandboxRoot();
  const workspaceRoot = path.join(
    root,
    tenantHashId,
    "workspaces",
    workspaceId,
  );
  const memoryPath = path.join(workspaceRoot, "AGENTS.md");

  try {
    if (await containsSymlink(root, [tenantHashId, "workspaces", workspaceId])) {
      return null;
    }

    const stats = await lstat(memoryPath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_PROJECT_MEMORY_BYTES) {
      return null;
    }

    const contentBytes = await readFile(memoryPath);
    if (contentBytes.byteLength > MAX_PROJECT_MEMORY_BYTES) {
      return null;
    }

    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(contentBytes);
    } catch {
      return null;
    }

    return {
      content,
      path: memoryPath,
      updatedAt: stats.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}

function getFilesystemSandboxRoot() {
  const configuredRoot = process.env.FILESYSTEM_SANDBOX_ROOT?.trim();
  return configuredRoot || path.join(process.cwd(), "var", "agent-files");
}

async function containsSymlink(root: string, segments: string[]) {
  let currentPath = root;
  try {
    const rootStats = await lstat(currentPath);
    if (rootStats.isSymbolicLink()) {
      return true;
    }

    for (const segment of segments) {
      currentPath = path.join(currentPath, segment);
      const stats = await lstat(currentPath);
      if (stats.isSymbolicLink()) {
        return true;
      }
    }
  } catch {
    return true;
  }

  return false;
}

function isSafePathSegment(value: string) {
  return Boolean(value) && value !== "." && value !== ".." && !/[\\/\0]/.test(value);
}
