import type { ThreadScope } from "@/lib/server/thread-store/persistence";
import {
  globFilesystemFiles,
  writeInternalFilesystemArtifact,
} from "@/lib/agent/services/filesystem-service";

type ContextOffloadArtifact = {
  artifactPath: string;
  args: unknown;
  createdAt: string;
  originalResult: unknown;
  originalSizeBytes: number;
  summary: string;
  toolCallId: string;
  toolName: string;
  version: 1;
};

export type WriteContextOffloadArtifactOptions = {
  args: unknown;
  originalResult: unknown;
  originalSizeBytes: number;
  summary: string;
  threadId: string;
  threadScope: ThreadScope;
  toolCallId: string;
  toolName: string;
};

export async function listContextOffloadReferences({
  threadId,
  threadScope,
}: Pick<WriteContextOffloadArtifactOptions, "threadId" | "threadScope">) {
  const result = await globFilesystemFiles(
    {
      threadId,
      threadScope,
    },
    {
      maxResults: 50,
      path: ".context/offloads",
      pattern: "*.json",
    },
  );

  return result.ok ? result.matches.map((match) => match.path) : [];
}

export async function writeContextOffloadArtifact({
  args,
  originalResult,
  originalSizeBytes,
  summary,
  threadId,
  threadScope,
  toolCallId,
  toolName,
}: WriteContextOffloadArtifactOptions) {
  const artifactPath = createArtifactPath(toolName);
  const artifact = {
    artifactPath,
    args,
    createdAt: new Date().toISOString(),
    originalResult,
    originalSizeBytes,
    summary,
    toolCallId,
    toolName,
    version: 1,
  } satisfies ContextOffloadArtifact;
  const writeResult = await writeInternalFilesystemArtifact(
    {
      threadId,
      threadScope,
    },
    {
      content: JSON.stringify(artifact, null, 2),
      path: artifactPath,
    },
  );

  return writeResult.ok
    ? {
        artifact,
        ok: true as const,
        path: writeResult.path,
        sizeBytes: writeResult.sizeBytes,
      }
    : writeResult;
}

function createArtifactPath(toolName: string) {
  const timestamp = new Date().toISOString().replace(/[^0-9a-zA-Z]/g, "-");
  const safeToolName =
    toolName.replace(/[^0-9a-zA-Z_-]/g, "_").slice(0, 80) || "tool";

  return `.context/offloads/${timestamp}-${safeToolName}-${crypto.randomUUID()}.json`;
}
