import fs from "node:fs/promises";
import path from "node:path";
import type {
  CommandExecutionContext,
  CommandExecutionResult,
  CommandExecutionStatus,
  SandboxExecutionRequest,
} from "./contracts";

export const COMMAND_DEFAULT_TIMEOUT_MS = 30_000;
export const COMMAND_MAX_TIMEOUT_MS = 120_000;
export const COMMAND_MAX_TOTAL_BYTES = 4_096;
export const COMMAND_MAX_STDOUT_BYTES = 64 * 1024;
export const COMMAND_MAX_STDERR_BYTES = 64 * 1024;
export const COMMAND_MAX_OUTPUT_BYTES =
  COMMAND_MAX_STDOUT_BYTES + COMMAND_MAX_STDERR_BYTES;

const COMMAND_MAX_ARGS = 32;
const COMMAND_MAX_ARG_LENGTH = 512;
const COMMAND_MAX_QUERY_LENGTH = 200;
const SANDBOX_ROOTS = ["workspace", "notes"] as const;

export type ValidatedCommandArgs = {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
};

type ValidationSuccess = {
  ok: true;
  value: Record<string, unknown>;
};

type ValidationFailure = {
  ok: false;
  message: string;
};

export type CommandValidationResult = ValidationSuccess | ValidationFailure;

export function validateExecuteCommandArgs(
  args: unknown,
): CommandValidationResult {
  if (!isRecord(args)) {
    return { message: "execute_command 参数必须是对象。", ok: false };
  }

  const allowedKeys = new Set(["command", "args", "cwd", "timeoutMs"]);
  const unknownKey = Object.keys(args).find((key) => !allowedKeys.has(key));
  if (unknownKey) {
    return {
      message: `execute_command 不支持参数：${unknownKey}。`,
      ok: false,
    };
  }

  const command = normalizeCommand(args.command);
  if (!command) {
    return {
      message: "execute_command.command 必须是非空命令名。",
      ok: false,
    };
  }

  const commandArgs = args.args === undefined ? [] : args.args;
  if (
    !Array.isArray(commandArgs) ||
    commandArgs.length > COMMAND_MAX_ARGS ||
    commandArgs.some(
      (value) =>
        typeof value !== "string" ||
        value.length > COMMAND_MAX_ARG_LENGTH ||
        value.includes("\0"),
    )
  ) {
    return {
      message: `execute_command.args 必须是最多 ${COMMAND_MAX_ARGS} 个短字符串。`,
      ok: false,
    };
  }

  const cwd = normalizeExecutionPath(args.cwd ?? SANDBOX_ROOTS[0]);
  if (!cwd || !isAllowedExecutionPath(cwd)) {
    return {
      message: "execute_command.cwd 只能位于 workspace 或 notes 目录。",
      ok: false,
    };
  }

  const timeoutMs = args.timeoutMs ?? COMMAND_DEFAULT_TIMEOUT_MS;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1_000 ||
    timeoutMs > COMMAND_MAX_TIMEOUT_MS
  ) {
    return {
      message: `execute_command.timeoutMs 必须是 1000-${COMMAND_MAX_TIMEOUT_MS} 之间的整数。`,
      ok: false,
    };
  }

  const normalizedArgs = commandArgs as string[];
  const commandError = validateCommandAllowlist(command, normalizedArgs);
  if (commandError) {
    return { message: commandError, ok: false };
  }

  const serializedLength = Buffer.byteLength(
    JSON.stringify({ command, args: normalizedArgs, cwd, timeoutMs }),
    "utf8",
  );
  if (serializedLength > COMMAND_MAX_TOTAL_BYTES) {
    return {
      message: `execute_command 参数总大小不能超过 ${COMMAND_MAX_TOTAL_BYTES} bytes。`,
      ok: false,
    };
  }

  const value: ValidatedCommandArgs = {
    args: normalizedArgs,
    command,
    cwd,
    timeoutMs,
  };
  return { ok: true, value };
}

export function createRejectedCommandResult(
  args: Record<string, unknown>,
  reason = "用户拒绝了本次命令执行。",
): CommandExecutionResult | undefined {
  const validation = validateExecuteCommandArgs(args);
  if (!validation.ok) {
    return undefined;
  }

  const value = validation.value as ValidatedCommandArgs;
  return {
    args: value.args,
    command: value.command,
    cwd: value.cwd,
    durationMs: 0,
    executionId: `exec:${crypto.randomUUID()}`,
    finishedAt: new Date().toISOString(),
    outputTruncated: false,
    status: "rejected",
    stderr: "",
    stdout: "",
    summary: reason,
  };
}

export function createExecutionSummary({
  command,
  cwd,
  exitCode,
  status,
  timedOut,
}: {
  command: string;
  cwd: string;
  exitCode?: number | null;
  status: CommandExecutionStatus;
  timedOut: boolean;
}) {
  if (timedOut || status === "timed_out") {
    return `命令「${command}」在「${cwd}」执行超时，已终止进程。`;
  }
  if (status === "completed") {
    return `命令「${command}」已在「${cwd}」中完成执行。`;
  }
  if (status === "cancelled") {
    return `命令「${command}」已取消。`;
  }
  return `命令「${command}」执行失败${exitCode === null || exitCode === undefined ? "" : `，退出码 ${exitCode}`}。`;
}

export function createCommandSummary(value: ValidatedCommandArgs) {
  const suffix = value.args.length ? ` ${value.args.join(" ")}` : "";
  return `将以受限模式执行「${value.command}${suffix}」：工作目录为「${value.cwd}」，网络关闭，文件只读。`;
}

export function isAllowedExecutionPath(input: string) {
  return SANDBOX_ROOTS.some(
    (root) => input === root || input.startsWith(`${root}/`),
  );
}

export function getCommandPathArgument(value: ValidatedCommandArgs) {
  if (value.command === "ls" || value.command === "find") {
    return value.args[0];
  }
  if (value.command === "rg") {
    return value.args[1];
  }
  if (
    value.command === "cat" ||
    value.command === "head" ||
    value.command === "tail" ||
    value.command === "wc"
  ) {
    return value.args[0];
  }
  if (value.command === "bun" && value.args.length === 2) {
    return value.args[1];
  }
  return undefined;
}

export async function resolveSandboxExecutionRequest(
  value: ValidatedCommandArgs,
  context: CommandExecutionContext,
): Promise<SandboxExecutionRequest> {
  const configuredRoot = process.env.FILESYSTEM_SANDBOX_ROOT?.trim();
  const configuredPath = configuredRoot
    ? path.resolve(configuredRoot)
    : path.join(/* turbopackIgnore: true */ process.cwd(), "var", "agent-files");
  const root = await resolveExistingPath(configuredPath);
  const sandboxRoot = path.join(
    root,
    sanitizePathSegment(context.threadScope.tenantHashId),
    sanitizePathSegment(context.threadScope.userHashId),
    sanitizePathSegment(context.threadId),
  );

  const allowedRoots = SANDBOX_ROOTS.map((segment) =>
    path.join(sandboxRoot, segment),
  );
  await assertNoSymlinkPath(sandboxRoot, root);
  await Promise.all(
    allowedRoots.map((allowedRoot) =>
      assertNoSymlinkPath(allowedRoot, sandboxRoot),
    ),
  );

  const cwdPath = path.join(sandboxRoot, value.cwd);
  await assertNoSymlinkPath(cwdPath, sandboxRoot);
  await assertCommandPathArguments(value, sandboxRoot);
  const relativeFromSandbox = path.relative(sandboxRoot, cwdPath);
  if (
    relativeFromSandbox.startsWith("..") ||
    path.isAbsolute(relativeFromSandbox) ||
    !isAllowedExecutionPath(relativeFromSandbox)
  ) {
    throw new Error("执行目录不能离开 workspace 或 notes。 ");
  }

  return {
    allowedRoots,
    args: value.args,
    command: value.command,
    cwd: value.cwd,
    outputLimitBytes: COMMAND_MAX_OUTPUT_BYTES,
    readOnly: true,
    timeoutMs: value.timeoutMs,
  };
}

function validateCommandAllowlist(command: string, args: string[]) {
  if (command === "pwd") {
    return args.length === 0 ? null : "pwd 不接受额外参数。";
  }

  if (command === "ls" || command === "find") {
    return args.length <= 1 && (!args[0] || isSafeCommandPath(args[0]))
      ? null
      : `${command} 只接受一个 workspace/notes 内的相对路径。`;
  }

  if (command === "rg") {
    if (
      args.length < 1 ||
      args.length > 2 ||
      !args[0].trim() ||
      args[0].length > COMMAND_MAX_QUERY_LENGTH
    ) {
      return "rg 需要一个不超过 200 个字符的搜索文本，最多再接一个相对路径。";
    }
    return args[1] && !isSafeCommandPath(args[1])
      ? "rg 的路径参数必须是相对路径。"
      : null;
  }

  if (
    command === "cat" ||
    command === "head" ||
    command === "tail" ||
    command === "wc"
  ) {
    return args.length === 1 && isSafeCommandPath(args[0])
      ? null
      : `${command} 只接受一个相对文件路径。`;
  }

  if (command === "bun") {
    if (args.length === 1 && args[0] === "test") {
      return null;
    }
    if (
      args.length === 2 &&
      args[0] === "test" &&
      isSafeCommandPath(args[1])
    ) {
      return null;
    }
    if (
      args.length === 2 &&
      args[0] === "run" &&
      (args[1] === "typecheck" ||
        args[1] === "lint" ||
        args[1] === "build")
    ) {
      return null;
    }
    return "bun 只允许 test、typecheck、lint 和 build 预设命令。";
  }

  return `命令「${command}」不在 M9 安全 allowlist 中。`;
}

function isSafeCommandPath(input: string) {
  const normalized = normalizeExecutionPath(input);
  return Boolean(normalized || input.trim() === ".");
}

function normalizeExecutionPath(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const raw = value.trim().replace(/\\/g, "/");
  if (
    !raw ||
    raw.includes("\0") ||
    raw.startsWith("/") ||
    raw.startsWith("~") ||
    raw.split("/").some((segment) => segment === "..")
  ) {
    return null;
  }
  const segments = raw.split("/").filter(Boolean);
  return segments.length ? segments.join("/") : null;
}

function normalizeCommand(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const command = value.trim();
  return command && command.length <= 64 && !command.includes("\0")
    ? command
    : null;
}

async function assertNoSymlinkPath(targetPath: string, stopAt: string) {
  const normalizedTarget = path.resolve(targetPath);
  const normalizedStop = path.resolve(stopAt);
  const relative = path.relative(normalizedStop, normalizedTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("执行路径超出当前 thread sandbox。 ");
  }

  const segments = relative ? relative.split(path.sep) : [];
  let current = normalizedStop;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const stats = await fs.lstat(current);
      if (stats.isSymbolicLink()) {
        throw new Error("执行路径不能包含 symlink。 ");
      }
    } catch (error) {
      if (isMissingPathError(error)) {
        return;
      }
      throw error;
    }
  }
}

async function assertCommandPathArguments(
  value: ValidatedCommandArgs,
  sandboxRoot: string,
) {
  const pathArgument = getCommandPathArgument(value);
  if (pathArgument) {
    await assertNoSymlinkPath(
      path.join(sandboxRoot, value.cwd, pathArgument),
      sandboxRoot,
    );
  }

  if (value.command === "bun" && value.args.length === 1) {
    await assertNoSymlinkTree(path.join(sandboxRoot, value.cwd));
  }
}

async function assertNoSymlinkTree(directory: string): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error("执行路径不能包含 symlink。 ");
    }
    if (entry.isDirectory()) {
      await assertNoSymlinkTree(entryPath);
    }
  }
}

function sanitizePathSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function isMissingPathError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function resolveExistingPath(value: string) {
  try {
    return await fs.realpath(value);
  } catch (error) {
    if (isMissingPathError(error)) {
      return value;
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
