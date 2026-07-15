import { ToolMessage } from "@langchain/core/messages";
import type { ThreadScope } from "@/lib/server/thread-store/persistence";
import { writeContextOffloadArtifact } from "./offload-store";

export type ContextOffloadPolicy = {
  maxInlineContentChars?: number;
  maxInlineResultBytes?: number;
};

export type ContextOffloadReference = {
  artifactPath: string;
  offloaded: true;
  originalSizeBytes: number;
  summary: string;
};

export type ToolResultOffloadOptions = {
  args: unknown;
  policy?: ContextOffloadPolicy;
  result: unknown;
  threadId?: string;
  threadScope?: ThreadScope;
  toolCallId: string;
  toolName: string;
};

export type ToolResultOffloadResult =
  | {
      artifactPath: string;
      offloaded: true;
      originalSizeBytes: number;
      result: ToolMessage;
      summary: string;
    }
  | {
      offloaded: false;
      reason: "missing_context" | "not_tool_message" | "under_limit" | "write_failed";
      writeError?: {
        code: string;
        message: string;
      };
    };

const DEFAULT_MAX_INLINE_RESULT_BYTES = 12_000;
const DEFAULT_MAX_INLINE_CONTENT_CHARS = 8_000;

export async function offloadToolResultIfNeeded({
  args,
  policy,
  result,
  threadId,
  threadScope,
  toolCallId,
  toolName,
}: ToolResultOffloadOptions): Promise<ToolResultOffloadResult> {
  if (!threadId || !threadScope) {
    return {
      offloaded: false,
      reason: "missing_context",
    };
  }

  if (!ToolMessage.isInstance(result)) {
    return {
      offloaded: false,
      reason: "not_tool_message",
    };
  }

  const originalResult = normalizeToolMessageForArtifact(result);
  const serializedResult = JSON.stringify(originalResult);
  const originalSizeBytes = Buffer.byteLength(serializedResult, "utf8");
  const parsedContent = parseJsonContent(result.content);
  const shouldOffload =
    originalSizeBytes > (policy?.maxInlineResultBytes ?? DEFAULT_MAX_INLINE_RESULT_BYTES) ||
    shouldForceReadFileOffload(
      toolName,
      parsedContent,
      policy?.maxInlineContentChars ?? DEFAULT_MAX_INLINE_CONTENT_CHARS,
    );

  if (!shouldOffload) {
    return {
      offloaded: false,
      reason: "under_limit",
    };
  }

  const summary = summarizeToolResult(toolName, parsedContent);
  const writeResult = await writeContextOffloadArtifact({
    args,
    originalResult,
    originalSizeBytes,
    summary,
    threadId,
    threadScope,
    toolCallId,
    toolName,
  });

  if (!writeResult.ok) {
    return {
      offloaded: false,
      reason: "write_failed",
      writeError: writeResult.error,
    };
  }

  const reference = {
    artifactPath: writeResult.path,
    offloaded: true,
    originalSizeBytes,
    summary,
  } satisfies ContextOffloadReference;

  return {
    artifactPath: reference.artifactPath,
    offloaded: true,
    originalSizeBytes,
    result: new ToolMessage({
      additional_kwargs: result.additional_kwargs,
      content: JSON.stringify(reference),
      id: result.id,
      metadata: {
        ...result.metadata,
        contextOffload: reference,
      },
      name: result.name,
      response_metadata: result.response_metadata,
      status: result.status,
      tool_call_id: result.tool_call_id,
    }),
    summary,
  };
}

function shouldForceReadFileOffload(
  toolName: string,
  parsedContent: unknown,
  maxInlineContentChars: number,
) {
  if (toolName !== "read_filesystem_file" || !isRecord(parsedContent)) {
    return false;
  }

  return (
    parsedContent.ok === true &&
    typeof parsedContent.content === "string" &&
    parsedContent.content.length > maxInlineContentChars
  );
}

function summarizeToolResult(toolName: string, parsedContent: unknown) {
  if (isRecord(parsedContent) && typeof parsedContent.summary === "string") {
    return parsedContent.summary;
  }

  if (toolName === "read_filesystem_file" && isRecord(parsedContent)) {
    const path = typeof parsedContent.path === "string" ? parsedContent.path : "unknown";
    const size =
      typeof parsedContent.sizeBytes === "number"
        ? `，大小 ${parsedContent.sizeBytes} bytes`
        : "";

    return `已读取文件 \`${path}\`${size}，原始内容已 offload。`;
  }

  return `工具 ${toolName} 的原始结果已 offload。`;
}

function normalizeToolMessageForArtifact(result: ToolMessage) {
  return {
    additional_kwargs: result.additional_kwargs,
    artifact: result.artifact,
    content: result.content,
    id: result.id,
    metadata: result.metadata,
    name: result.name,
    response_metadata: result.response_metadata,
    status: result.status,
    tool_call_id: result.tool_call_id,
    type: result.type,
  };
}

function parseJsonContent(content: unknown) {
  if (typeof content !== "string") {
    return null;
  }

  try {
    return JSON.parse(content) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
