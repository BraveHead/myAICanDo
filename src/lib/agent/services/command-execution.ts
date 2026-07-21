import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

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
const SANDBOX_WORKSPACE_ROOT = "workspace";
const SANDBOX_NOTES_ROOT = "notes";
const SANDBOX_ROOTS = [SANDBOX_WORKSPACE_ROOT, SANDBOX_NOTES_ROOT] as const;
const EXECUTION_IMAGE = "oven/bun:1.3.5-alpine";
const SANDBOX_EXECUTION_PATH =
  "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

export type CommandExecutionStatus =
  | "completed"
  | "failed"
  | "timed_out"
  | "rejected"
  | "sandbox_unavailable";

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

export type SandboxBackend = "macos-sandbox-exec" | "docker" | "mock";

export interface SandboxExecutor {
  execute(request: SandboxExecutionRequest): Promise<CommandExecutionResult>;
}

type ValidatedCommandArgs = {
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

export type CommandValidationResult =
  | ValidationSuccess
  | ValidationFailure;

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

  const cwd = normalizeExecutionPath(args.cwd ?? SANDBOX_WORKSPACE_ROOT);
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

export async function prepareCommandApprovalPreview(
  args: Record<string, unknown>,
  context: CommandExecutionContext,
): Promise<CommandApprovalPreview> {
  const validation = validateExecuteCommandArgs(args);
  if (!validation.ok) {
    throw new Error(validation.message);
  }

  await resolveExecutionRequest(
    validation.value as ValidatedCommandArgs,
    context,
  );
  const value = validation.value as ValidatedCommandArgs;
  return {
    args: value.args,
    command: value.command,
    cwd: value.cwd,
    filesystem: "read-only",
    kind: "command",
    network: "disabled",
    summary: createCommandSummary(value),
    timeoutMs: value.timeoutMs,
  };
}

export async function executeCommandInSandbox(
  args: Record<string, unknown>,
  context: CommandExecutionContext,
  executor: SandboxExecutor = createSandboxExecutor(),
): Promise<CommandExecutionToolResult> {
  const validation = validateExecuteCommandArgs(args);
  if (!validation.ok) {
    return createCommandError("invalid_tool_args", validation.message);
  }

  let request: SandboxExecutionRequest;
  try {
    request = await resolveExecutionRequest(
      validation.value as ValidatedCommandArgs,
      context,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "执行路径无效。";
    return createCommandError("sandbox_path_invalid", message);
  }

  const result = await executor.execute(request);
  if (result.status === "completed") {
    return {
      commandResult: result,
      ok: true,
      summary: result.summary,
    };
  }

  return {
    commandResult: result,
    error: {
      code: `command_${result.status}`,
      message: result.summary,
    },
    ok: false,
    summary: result.summary,
  };
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

export function createSandboxExecutor(): SandboxExecutor {
  const configuredBackend = process.env.EXECUTION_SANDBOX_BACKEND?.trim();
  const backend = configuredBackend || "auto";

  if (backend === "mock" && process.env.NODE_ENV === "test") {
    return new UnavailableSandboxExecutor("mock");
  }

  if (backend === "docker") {
    return new DockerSandboxExecutor();
  }

  if (backend === "macos") {
    return new MacosSandboxExecutor();
  }

  if (backend === "auto" && process.platform === "darwin") {
    return new MacosSandboxExecutor();
  }

  if (backend === "auto") {
    return new DockerSandboxExecutor();
  }

  return new UnavailableSandboxExecutor();
}

export function createCommandResultEvent(
  result: CommandExecutionResult,
  approvalId?: string,
) {
  return {
    type: "command_result" as const,
    ...(approvalId ? { approvalId } : {}),
    args: result.args,
    command: result.command,
    cwd: result.cwd,
    durationMs: result.durationMs,
    executionId: result.executionId,
    exitCode: result.exitCode,
    finishedAt: result.finishedAt,
    outputTruncated: result.outputTruncated,
    status: result.status,
    stderr: result.stderr,
    stdout: result.stdout,
    summary: result.summary,
  };
}

async function resolveExecutionRequest(
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
  await Promise.all(allowedRoots.map((allowedRoot) => assertNoSymlinkPath(allowedRoot, sandboxRoot)));

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

class UnavailableSandboxExecutor implements SandboxExecutor {
  constructor(private readonly backend?: SandboxBackend) {}

  async execute(request: SandboxExecutionRequest) {
    return createUnavailableResult(request, this.backend);
  }
}

class MacosSandboxExecutor implements SandboxExecutor {
  async execute(request: SandboxExecutionRequest) {
    if (process.platform !== "darwin") {
      return createUnavailableResult(request, "macos-sandbox-exec");
    }

    const executablePath = await resolveExecutablePath(request.command);
    if (!executablePath) {
      return createFailedResult(
        request,
        "failed",
        `未找到允许执行的命令「${request.command}」。`,
        "macos-sandbox-exec",
      );
    }

    const profileDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "my-ai-m9-profile-"),
    );
    const profilePath = path.join(profileDirectory, "profile.sb");
    const tempDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "my-ai-m9-exec-"),
    );

    try {
      await fs.writeFile(
        profilePath,
        createMacosSandboxProfile({
          commandPath: executablePath,
          allowedRoots: request.allowedRoots,
          sandboxRoot: getSandboxRootFromRequest(request),
          tempDirectory,
        }),
        "utf8",
      );

      return await executeChildProcess({
        args: ["-f", profilePath, executablePath, ...request.args],
        backend: "macos-sandbox-exec",
        cwd: path.join(getSandboxRootFromRequest(request), request.cwd),
        executable: "/usr/bin/sandbox-exec",
        request,
      });
    } finally {
      await Promise.all([
        fs.rm(profileDirectory, { force: true, recursive: true }),
        fs.rm(tempDirectory, { force: true, recursive: true }),
      ]);
    }
  }
}

class DockerSandboxExecutor implements SandboxExecutor {
  async execute(request: SandboxExecutionRequest) {
    const dockerPath = await resolveExecutablePath("docker");
    if (!dockerPath) {
      return createUnavailableResult(request, "docker");
    }

    const image = process.env.EXECUTION_SANDBOX_IMAGE?.trim() || EXECUTION_IMAGE;
    const root = getSandboxRootFromRequest(request);
    const args = [
      "run",
      "--rm",
      "--init",
      "--network=none",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--pids-limit=64",
      "--memory=512m",
      "--cpus=1",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,nodev,size=64m",
      "--mount",
      `type=bind,source=${request.allowedRoots[0]},destination=/sandbox/workspace,readonly`,
      "--mount",
      `type=bind,source=${request.allowedRoots[1]},destination=/sandbox/notes,readonly`,
      "--workdir",
      `/sandbox/${request.cwd}`,
      image,
      request.command,
      ...request.args,
    ];

    return executeChildProcess({
      args,
      backend: "docker",
      cwd: root,
      executable: dockerPath,
      request,
    });
  }
}

async function executeChildProcess({
  args,
  backend,
  cwd,
  executable,
  request,
}: {
  args: string[];
  backend: SandboxBackend;
  cwd: string;
  executable: string;
  request: SandboxExecutionRequest;
}) {
  const executionId = `exec:${crypto.randomUUID()}`;
  const startedAt = Date.now();
  const environment = {
    HOME: os.tmpdir(),
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    NODE_ENV: "production" as const,
    PATH: SANDBOX_EXECUTION_PATH,
    TZ: "UTC",
  };

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(executable, args, {
      cwd,
      detached: process.platform !== "win32",
      env: environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end();
  } catch (error) {
    return createFailedResult(
      request,
      "failed",
      error instanceof Error ? error.message : "启动 sandbox 失败。",
      backend,
      executionId,
      startedAt,
    );
  }

  return new Promise<CommandExecutionResult>((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let totalBytes = 0;
    let outputTruncated = false;
    let settled = false;
    let timedOut = false;

    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      const limit =
        target === "stdout" ? COMMAND_MAX_STDOUT_BYTES : COMMAND_MAX_STDERR_BYTES;
      const used = target === "stdout" ? stdoutBytes : stderrBytes;
      const remaining = Math.max(0, Math.min(limit - used, COMMAND_MAX_OUTPUT_BYTES - totalBytes));
      if (remaining <= 0) {
        outputTruncated = true;
        return;
      }

      const next = chunk.subarray(0, remaining);
      if (target === "stdout") {
        stdout.push(next);
        stdoutBytes += next.byteLength;
      } else {
        stderr.push(next);
        stderrBytes += next.byteLength;
      }
      totalBytes += next.byteLength;
      if (next.byteLength < chunk.byteLength) {
        outputTruncated = true;
      }
    };

    const finish = (status: CommandExecutionStatus, exitCode?: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      const durationMs = Date.now() - startedAt;
      const summary = createExecutionSummary({
        command: request.command,
        cwd: request.cwd,
        exitCode,
        status,
        timedOut,
      });
      resolve({
        args: request.args,
        backend,
        command: request.command,
        cwd: request.cwd,
        durationMs,
        ...(exitCode !== undefined ? { exitCode } : {}),
        executionId,
        finishedAt: new Date().toISOString(),
        outputTruncated,
        status,
        stderr: sanitizeExecutionOutput(
          Buffer.concat(stderr).toString("utf8"),
          request,
        ),
        stdout: sanitizeExecutionOutput(
          Buffer.concat(stdout).toString("utf8"),
          request,
        ),
        summary,
      });
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      killChildProcess(child);
      finish("timed_out", null);
    }, request.timeoutMs);

    child.stdout.on("data", (chunk: Buffer | string) => {
      append("stdout", Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      append("stderr", Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.on("error", () => {
      finish("failed", null);
    });
    child.on("close", (exitCode) => {
      if (timedOut) {
        return;
      }
      finish(exitCode === 0 ? "completed" : "failed", exitCode);
    });
  });
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

  if (command === "cat" || command === "head" || command === "tail" || command === "wc") {
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
      (args[1] === "typecheck" || args[1] === "lint" || args[1] === "build")
    ) {
      return null;
    }
    return "bun 只允许 test、typecheck、lint 和 build 预设命令。";
  }

  return `命令「${command}」不在 M9 安全 allowlist 中。`;
}

function createCommandError(code: string, message: string): CommandExecutionToolResult {
  return {
    error: { code, message },
    ok: false,
    summary: message,
  };
}

function createUnavailableResult(
  request: SandboxExecutionRequest,
  backend?: SandboxBackend,
): CommandExecutionResult {
  return {
    args: request.args,
    ...(backend ? { backend } : {}),
    command: request.command,
    cwd: request.cwd,
    durationMs: 0,
    executionId: `exec:${crypto.randomUUID()}`,
    finishedAt: new Date().toISOString(),
    outputTruncated: false,
    status: "sandbox_unavailable",
    stderr: "",
    stdout: "",
    summary: "当前环境没有可用的安全执行 Sandbox，已阻止命令执行。",
  };
}

function createFailedResult(
  request: SandboxExecutionRequest,
  status: "failed" | "timed_out",
  summary: string,
  backend: SandboxBackend,
  executionId = `exec:${crypto.randomUUID()}`,
  startedAt = Date.now(),
): CommandExecutionResult {
  return {
    args: request.args,
    backend,
    command: request.command,
    cwd: request.cwd,
    durationMs: Date.now() - startedAt,
    executionId,
    finishedAt: new Date().toISOString(),
    outputTruncated: false,
    status,
    stderr: "",
    stdout: "",
    summary,
  };
}

function createExecutionSummary({
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
  return `命令「${command}」执行失败${exitCode === null || exitCode === undefined ? "" : `，退出码 ${exitCode}`}。`;
}

function createCommandSummary(value: ValidatedCommandArgs) {
  const suffix = value.args.length ? ` ${value.args.join(" ")}` : "";
  return `将以受限模式执行「${value.command}${suffix}」：工作目录为「${value.cwd}」，网络关闭，文件只读。`;
}

function createMacosSandboxProfile({
  allowedRoots,
  commandPath,
  sandboxRoot,
  tempDirectory,
}: {
  allowedRoots: string[];
  commandPath: string;
  sandboxRoot: string;
  tempDirectory: string;
}) {
  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(deny process-exec)",
    `(allow process-exec (literal ${sandboxLiteral(commandPath)}))`,
    `(allow process-exec (literal "/usr/bin/sandbox-exec"))`,
    "(deny network*)",
    "(allow file-read* (subpath \"/\"))",
    "(deny file-read* (subpath \"/Users\"))",
    "(deny file-read* (subpath \"/Applications\"))",
    "(deny file-read* (subpath \"/Volumes\"))",
    "(deny file-read* (subpath \"/Library\"))",
    "(deny file-read* (subpath \"/opt\"))",
    "(deny file-read* (subpath \"/private/etc\"))",
    "(deny file-read* (subpath \"/var/folders\"))",
    "(deny file-read* (subpath \"/private/var/folders\"))",
    "(allow file-read-metadata (subpath \"/Users\"))",
    "(allow file-read-metadata (subpath \"/private/var\"))",
    "(allow file-read-metadata (subpath \"/private/var/folders\"))",
    "(allow file-read-metadata (subpath \"/var/folders\"))",
    ...[
      "/System",
      "/usr",
      "/bin",
      "/sbin",
      "/Library/Frameworks",
      "/private/var/db",
      "/dev",
      path.dirname(commandPath),
    ].map((entry) => `(allow file-read* (subpath ${sandboxLiteral(entry)}))`),
    ...allowedRoots.map(
      (entry) => `(allow file-read* (subpath ${sandboxLiteral(entry)}))`,
    ),
    `(allow file-read-metadata (subpath ${sandboxLiteral(sandboxRoot)}))`,
    `(allow file-read* (subpath ${sandboxLiteral(tempDirectory)}))`,
    `(allow file-write* (subpath ${sandboxLiteral(tempDirectory)}))`,
  ];
  return `${lines.join("\n")}\n`;
}

function sandboxLiteral(value: string) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function sanitizeExecutionOutput(
  value: string,
  request: SandboxExecutionRequest,
) {
  const sandboxRoot = getSandboxRootFromRequest(request);
  return value.split(sandboxRoot).join("/sandbox");
}

function getSandboxRootFromRequest(request: SandboxExecutionRequest) {
  return path.dirname(request.allowedRoots[0]);
}

async function resolveExecutablePath(command: string) {
  if (path.isAbsolute(command) || command.includes("/")) {
    return null;
  }

  for (const directory of SANDBOX_EXECUTION_PATH.split(path.delimiter)) {
    if (!directory) {
      continue;
    }
    const candidate = path.join(directory, command);
    try {
      await fs.access(candidate, fsConstants.X_OK);
      const stats = await fs.stat(candidate);
      if (stats.isFile()) {
        return candidate;
      }
    } catch {
      // Continue searching the fixed PATH entries.
    }
  }
  return null;
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

function isAllowedExecutionPath(input: string) {
  return SANDBOX_ROOTS.some(
    (root) => input === root || input.startsWith(`${root}/`),
  );
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

function getCommandPathArgument(value: ValidatedCommandArgs) {
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

function sanitizePathSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function killChildProcess(child: ChildProcessWithoutNullStreams) {
  if (!child.pid) {
    return;
  }

  try {
    if (process.platform === "win32") {
      child.kill("SIGKILL");
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    child.kill("SIGKILL");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
