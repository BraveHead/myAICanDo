export type CommandExecutionStatus =
  | "completed"
  | "failed"
  | "timed_out"
  | "rejected"
  | "sandbox_unavailable"
  | "cancelled"
  | "expired";

export type SandboxBackend = "macos-sandbox-exec" | "docker" | "mock";

export type CommandExecutionResult = {
  executionId: string;
  command: string;
  args: string[];
  cwd: string;
  status: CommandExecutionStatus;
  exitCode?: number | null;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  durationMs: number;
  summary: string;
  finishedAt: string;
  backend?: SandboxBackend;
};

export type CommandApprovalPreview = {
  command: string;
  args: string[];
  cwd: string;
  filesystem: "read-only";
  kind: "command";
  network: "disabled";
  summary: string;
  timeoutMs: number;
};

export type CommandExecutionToolResult =
  | {
      commandResult: CommandExecutionResult;
      ok: true;
      summary: string;
    }
  | {
      commandResult?: CommandExecutionResult;
      error: {
        code: string;
        message: string;
      };
      ok: false;
      summary: string;
    };

export type CommandExecutionContext = {
  threadId: string;
  threadScope: {
    tenantHashId: string;
    userHashId: string;
    workspaceId: string;
  };
};

export type SandboxExecutionRequest = {
  command: string;
  args: string[];
  cwd: string;
  allowedRoots: string[];
  timeoutMs: number;
  outputLimitBytes: number;
  readOnly: true;
};

export type SandboxOutputChunk = {
  byteLength: number;
  output: string;
  stream: "stdout" | "stderr";
};

export type SandboxExecutionOptions = {
  abortStatus?: Extract<CommandExecutionStatus, "cancelled" | "failed">;
  abortSummary?: string;
  executionId?: string;
  onOutput?: (chunk: SandboxOutputChunk) => Promise<void> | void;
  signal?: AbortSignal;
};

export interface SandboxExecutor {
  execute(
    request: SandboxExecutionRequest,
    options?: SandboxExecutionOptions,
  ): Promise<CommandExecutionResult>;
}

export const COMMAND_EXECUTION_MAX_ATTEMPTS = 3;
export const COMMAND_EXECUTION_EVENT_CHUNK_BYTES = 8 * 1024;

export const COMMAND_EXECUTION_TERMINAL_STATUSES = [
  "completed",
  "failed",
  "timed_out",
  "sandbox_unavailable",
  "cancelled",
  "expired",
] as const;

export type CommandExecutionTaskStatus =
  | "queued"
  | "running"
  | "cancel_requested"
  | (typeof COMMAND_EXECUTION_TERMINAL_STATUSES)[number];

export type CommandExecutionSnapshot = {
  agentId: string;
  approvalId: string;
  args: string[];
  attempt: number;
  backend?: SandboxBackend;
  cancelRequestedAt: string | null;
  command: string;
  createdAt: string;
  cwd: string;
  executionId: string;
  failureCode?: string;
  finishedAt: string | null;
  lastEventId: string | null;
  leaseExpiresAt: string | null;
  maxAttempts: number;
  outputTruncated: boolean;
  parentExecutionId: string | null;
  result?: CommandExecutionResult;
  rootExecutionId: string;
  startedAt: string | null;
  status: CommandExecutionTaskStatus;
  stderr: string;
  stdout: string;
  summary: string;
  threadId: string;
  timeoutMs: number;
  toolCallId: string;
  updatedAt: string;
  workspaceId: string;
};

export type CommandOutputEvent = {
  byteLength: number;
  executionId: string;
  output: string;
  stream: "stdout" | "stderr";
  type: "command_output";
};

export type CommandStateEvent = {
  execution: CommandExecutionSnapshot;
  type: "command_state";
};

export type CommandExecutionResultEvent = {
  execution: CommandExecutionSnapshot;
  result: CommandExecutionResult;
  type: "command_result";
};

export type CommandExecutionEvent =
  | CommandOutputEvent
  | CommandStateEvent
  | CommandExecutionResultEvent;

const COMMAND_EXECUTION_TRANSITIONS: Record<
  CommandExecutionTaskStatus,
  readonly CommandExecutionTaskStatus[]
> = {
  cancel_requested: ["cancelled", "completed", "failed", "timed_out"],
  cancelled: [],
  completed: [],
  expired: [],
  failed: [],
  queued: ["running", "cancel_requested", "cancelled", "expired"],
  running: [
    "completed",
    "failed",
    "timed_out",
    "sandbox_unavailable",
    "cancel_requested",
  ],
  sandbox_unavailable: [],
  timed_out: [],
};

export type PersistedCommandExecutionEvent = {
  createdAt: string;
  event: CommandExecutionEvent;
  id: string;
};

export function isCommandExecutionTerminalStatus(
  status: CommandExecutionTaskStatus,
) {
  return COMMAND_EXECUTION_TERMINAL_STATUSES.some(
    (terminalStatus) => terminalStatus === status,
  );
}

export function isCommandExecutionTaskStatus(
  value: unknown,
): value is CommandExecutionTaskStatus {
  return (
    value === "queued" ||
    value === "running" ||
    value === "cancel_requested" ||
    COMMAND_EXECUTION_TERMINAL_STATUSES.some((status) => status === value)
  );
}

export function canTransitionCommandExecution(
  from: CommandExecutionTaskStatus,
  to: CommandExecutionTaskStatus,
) {
  return COMMAND_EXECUTION_TRANSITIONS[from].some((status) => status === to);
}

export function isCommandExecutionSnapshot(
  value: unknown,
): value is CommandExecutionSnapshot {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.agentId === "string" &&
    typeof value.approvalId === "string" &&
    Array.isArray(value.args) &&
    value.args.every((arg) => typeof arg === "string") &&
    typeof value.attempt === "number" &&
    typeof value.command === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.cwd === "string" &&
    typeof value.executionId === "string" &&
    (value.finishedAt === null || typeof value.finishedAt === "string") &&
    (value.lastEventId === null || typeof value.lastEventId === "string") &&
    typeof value.maxAttempts === "number" &&
    typeof value.outputTruncated === "boolean" &&
    (value.parentExecutionId === null ||
      typeof value.parentExecutionId === "string") &&
    typeof value.rootExecutionId === "string" &&
    (value.startedAt === null || typeof value.startedAt === "string") &&
    isCommandExecutionTaskStatus(value.status) &&
    typeof value.stderr === "string" &&
    typeof value.stdout === "string" &&
    typeof value.summary === "string" &&
    typeof value.threadId === "string" &&
    typeof value.timeoutMs === "number" &&
    typeof value.toolCallId === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.workspaceId === "string"
  );
}

export function isPersistedCommandExecutionEvent(
  value: unknown,
): value is PersistedCommandExecutionEvent {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.createdAt !== "string" ||
    !isRecord(value.event)
  ) {
    return false;
  }

  const event = value.event;
  if (event.type === "command_output") {
    return (
      typeof event.executionId === "string" &&
      (event.stream === "stdout" || event.stream === "stderr") &&
      typeof event.output === "string" &&
      typeof event.byteLength === "number"
    );
  }
  if (event.type === "command_state") {
    return isCommandExecutionSnapshot(event.execution);
  }
  if (event.type === "command_result") {
    return (
      isCommandExecutionSnapshot(event.execution) && isRecord(event.result)
    );
  }
  return false;
}

export function reduceCommandExecutionEvent(
  current: CommandExecutionSnapshot,
  persisted: PersistedCommandExecutionEvent,
) {
  if (
    current.lastEventId !== null &&
    BigInt(persisted.id) <= BigInt(current.lastEventId)
  ) {
    return current;
  }
  const event = persisted.event;
  if (event.type === "command_state" || event.type === "command_result") {
    return {
      ...event.execution,
      lastEventId: persisted.id,
    };
  }
  return {
    ...current,
    lastEventId: persisted.id,
    [event.stream]: `${current[event.stream]}${event.output}`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
