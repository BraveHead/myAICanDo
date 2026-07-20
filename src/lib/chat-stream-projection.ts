import type {
  ChatStreamEvent,
  FilesystemChangeEvent,
  SubagentEndEvent,
  SubagentStartEvent,
  SubagentId,
} from "@/lib/chat-stream";

export type SubagentProjection = {
  agent: SubagentId;
  durationMs?: number;
  error?: string;
  finishedAt?: string;
  parentAgentId: string;
  startedAt: string;
  status: "running" | "completed" | "failed";
  subtaskId: string;
  summary?: string;
  taskSummary: string;
};

export type ChatStreamProjection = {
  filesystemChanges: FilesystemChangeEvent[];
  subagents: SubagentProjection[];
};

export function dedupeFilesystemChanges(
  changes: readonly (FilesystemChangeEvent | undefined)[],
  emittedChangeIds: Set<string>,
) {
  return changes.filter((change): change is FilesystemChangeEvent => {
    if (!change || emittedChangeIds.has(change.changeId)) {
      return false;
    }

    emittedChangeIds.add(change.changeId);
    return true;
  });
}

export function createChatStreamProjection(): ChatStreamProjection {
  return {
    filesystemChanges: [],
    subagents: [],
  };
}

export function applyChatStreamProjection(
  projection: ChatStreamProjection,
  event: ChatStreamEvent,
): ChatStreamProjection {
  if (event.type === "subagent_start") {
    return {
      ...projection,
      subagents: upsertSubagentStart(projection.subagents, event),
    };
  }

  if (event.type === "subagent_end") {
    return {
      ...projection,
      subagents: upsertSubagentEnd(projection.subagents, event),
    };
  }

  if (event.type === "filesystem_change") {
    const index = projection.filesystemChanges.findIndex(
      (change) => change.changeId === event.changeId,
    );
    const filesystemChanges = [...projection.filesystemChanges];
    if (index === -1) {
      filesystemChanges.push(event);
    } else {
      filesystemChanges[index] = event;
    }

    return {
      ...projection,
      filesystemChanges,
    };
  }

  return projection;
}

function upsertSubagentStart(
  subagents: SubagentProjection[],
  event: SubagentStartEvent,
) {
  const index = subagents.findIndex(
    (subagent) => subagent.subtaskId === event.subtaskId,
  );
  const next: SubagentProjection = {
    agent: event.agent,
    parentAgentId: event.parentAgentId,
    startedAt: event.startedAt,
    status: "running",
    subtaskId: event.subtaskId,
    taskSummary: event.taskSummary,
  };

  if (index === -1) {
    return [...subagents, next];
  }

  const result = [...subagents];
  result[index] = {
    ...result[index],
    ...next,
  };
  return result;
}

function upsertSubagentEnd(
  subagents: SubagentProjection[],
  event: SubagentEndEvent,
) {
  const index = subagents.findIndex(
    (subagent) => subagent.subtaskId === event.subtaskId,
  );
  const current =
    index === -1
      ? {
          agent: event.agent,
          parentAgentId: "unknown",
          startedAt: event.finishedAt,
          status: "running" as const,
          subtaskId: event.subtaskId,
          taskSummary: "子任务",
        }
      : subagents[index];
  const next: SubagentProjection = {
    ...current,
    ...(event.error ? { error: event.error } : {}),
    durationMs: event.durationMs,
    finishedAt: event.finishedAt,
    status: event.status,
    summary: event.summary,
  };

  if (index === -1) {
    return [...subagents, next];
  }

  const result = [...subagents];
  result[index] = next;
  return result;
}

export function createFilesystemChangeEvent({
  approvalId,
  args,
  changeId,
  result,
  status,
  toolCallId,
  toolName,
}: {
  approvalId?: string;
  args?: unknown;
  changeId?: string;
  result: unknown;
  status?: FilesystemChangeEvent["status"];
  toolCallId?: string;
  toolName: string;
}): FilesystemChangeEvent | null {
  if (
    toolName !== "write_file" &&
    toolName !== "edit_file" &&
    toolName !== "delete_file"
  ) {
    return null;
  }

  const payload = parseFilesystemResult(result);
  const argsRecord = isRecord(args) ? args : {};
  const path =
    typeof payload?.path === "string"
      ? payload.path
      : typeof argsRecord.path === "string"
        ? argsRecord.path
        : null;
  if (!path) {
    return null;
  }

  const operation = getFilesystemOperation(toolName, payload, argsRecord);
  const isSuccess = payload?.ok === true;
  const isFailure = payload?.ok === false || status === "failed";
  const nextStatus = status ?? (isSuccess && !isFailure ? "completed" : "failed");
  const summary =
    typeof payload?.summary === "string" && payload.summary.trim()
      ? payload.summary
      : nextStatus === "completed"
        ? `已完成文件操作：${path}`
        : `文件操作未完成：${path}`;
  const sizeBytes = getNumber(payload, "newSizeBytes") ?? getNumber(payload, "sizeBytes");
  const replacements = getNumber(payload, "replacements");

  return {
    ...(approvalId ? { approvalId } : {}),
    changeId: changeId ?? `filesystem:${toolCallId ?? crypto.randomUUID()}`,
    operation,
    path,
    ...(replacements !== undefined ? { replacements } : {}),
    ...(sizeBytes !== undefined ? { sizeBytes } : {}),
    status: nextStatus,
    summary,
    ...(toolCallId ? { toolCallId } : {}),
    type: "filesystem_change",
  };
}

function getFilesystemOperation(
  toolName: string,
  payload: Record<string, unknown> | null,
  args: Record<string, unknown>,
): FilesystemChangeEvent["operation"] {
  if (toolName === "edit_file") {
    return "edit";
  }
  if (toolName === "delete_file") {
    return "delete";
  }
  if (payload?.operation === "create" || payload?.operation === "overwrite") {
    return payload.operation;
  }
  return args.overwrite === true ? "overwrite" : "create";
}

function parseFilesystemResult(result: unknown): Record<string, unknown> | null {
  if (typeof result === "string") {
    return parseJsonRecord(result);
  }
  if (!isRecord(result)) {
    return null;
  }
  if (typeof result.content === "string") {
    return parseJsonRecord(result.content) ?? result;
  }
  return result;
}

function parseJsonRecord(value: string) {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function getNumber(value: Record<string, unknown> | null, key: string) {
  const candidate = value?.[key];
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? candidate
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
