import "server-only";

import { listMemories, type MemoryScope } from "@/lib/server/memory-store";
import { listContextOffloadReferences } from "../context/offload-store";
import { loadWorkspaceProjectMemory } from "./project-memory-loader";
import type { MemoryManifest } from "./types";

const USER_MEMORY_LIMIT = 20;

export async function buildMemoryManifest({
  scope,
  threadId,
}: {
  scope: MemoryScope & { workspaceId: string };
  threadId: string;
}): Promise<MemoryManifest> {
  const [memories, projectMemory, offloadReferences] = await Promise.all([
    listMemories(scope, { limit: USER_MEMORY_LIMIT }),
    loadWorkspaceProjectMemory({
      tenantHashId: scope.tenantHashId,
      workspaceId: scope.workspaceId,
    }),
    listContextOffloadReferences({
      threadId,
      threadScope: scope,
    }),
  ]);

  return {
    schemaVersion: 1,
    user: memories.map((memory) => ({
      content: memory.content,
      id: memory.memoryId,
      key: memory.memoryKey,
      source: "memory-store" as const,
      updatedAt: memory.updatedAt,
    })),
    project: projectMemory
      ? [
          {
            content: projectMemory.content,
            id: `project-file:${scope.workspaceId}:AGENTS.md`,
            path: "AGENTS.md",
            source: "project-file" as const,
            updatedAt: projectMemory.updatedAt,
          },
        ]
      : [],
    harness: {
      threadId,
      offloadReferences,
    },
  };
}

export function withHarnessMemory(
  manifest: MemoryManifest | undefined,
  {
    threadId,
    todoState,
  }: {
    threadId?: string;
    todoState?: MemoryManifest["harness"]["todoState"];
  },
) {
  if (!manifest && !threadId) {
    return manifest;
  }

  return {
    schemaVersion: 1,
    user: manifest?.user ?? [],
    project: manifest?.project ?? [],
    harness: {
      ...manifest?.harness,
      threadId: threadId ?? manifest?.harness.threadId ?? "unknown",
      todoState,
      offloadReferences: manifest?.harness.offloadReferences ?? [],
    },
  } satisfies MemoryManifest;
}
