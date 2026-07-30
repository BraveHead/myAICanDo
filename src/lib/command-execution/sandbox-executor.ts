import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
  COMMAND_MAX_OUTPUT_BYTES,
  COMMAND_MAX_STDERR_BYTES,
  COMMAND_MAX_STDOUT_BYTES,
  createExecutionSummary,
} from "./command-policy";
import type {
  CommandExecutionResult,
  CommandExecutionStatus,
  SandboxBackend,
  SandboxExecutionOptions,
  SandboxExecutionRequest,
  SandboxExecutor,
} from "./contracts";

const EXECUTION_IMAGE = "oven/bun:1.3.5-alpine";
const SANDBOX_EXECUTION_PATH =
  "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

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

class UnavailableSandboxExecutor implements SandboxExecutor {
  constructor(private readonly backend?: SandboxBackend) {}

  async execute(
    request: SandboxExecutionRequest,
    options?: SandboxExecutionOptions,
  ) {
    return createUnavailableResult(
      request,
      this.backend,
      options?.executionId,
    );
  }
}

class MacosSandboxExecutor implements SandboxExecutor {
  async execute(
    request: SandboxExecutionRequest,
    options?: SandboxExecutionOptions,
  ) {
    if (process.platform !== "darwin") {
      return createUnavailableResult(
        request,
        "macos-sandbox-exec",
        options?.executionId,
      );
    }

    const executablePath = await resolveExecutablePath(request.command);
    if (!executablePath) {
      return createFailedResult(
        request,
        "failed",
        `未找到允许执行的命令「${request.command}」。`,
        "macos-sandbox-exec",
        options?.executionId,
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
        options,
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
  async execute(
    request: SandboxExecutionRequest,
    options?: SandboxExecutionOptions,
  ) {
    const dockerPath = await resolveExecutablePath("docker");
    if (!dockerPath) {
      return createUnavailableResult(request, "docker", options?.executionId);
    }

    const image = process.env.EXECUTION_SANDBOX_IMAGE?.trim() || EXECUTION_IMAGE;
    const root = getSandboxRootFromRequest(request);
    const executionId = options?.executionId ?? `exec:${crypto.randomUUID()}`;
    const containerName = createDockerContainerName(executionId);
    const args = [
      "run",
      "--rm",
      "--init",
      "--name",
      containerName,
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
      onAbortCleanup: () =>
        removeDockerContainer(dockerPath, containerName),
      options: {
        ...options,
        executionId,
      },
      request,
    });
  }
}

async function executeChildProcess({
  args,
  backend,
  cwd,
  executable,
  onAbortCleanup,
  options,
  request,
}: {
  args: string[];
  backend: SandboxBackend;
  cwd: string;
  executable: string;
  onAbortCleanup?: () => Promise<void>;
  options?: SandboxExecutionOptions;
  request: SandboxExecutionRequest;
}) {
  const executionId = options?.executionId ?? `exec:${crypto.randomUUID()}`;
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

  if (options?.signal?.aborted) {
    killChildProcess(child);
    await onAbortCleanup?.();
    return createFailedResult(
      request,
      options.abortStatus ?? "cancelled",
      options.abortSummary ?? "命令执行已取消。",
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
    let finishing = false;
    let timedOut = false;
    let outputChain = Promise.resolve();
    const outputDecoders = {
      stderr: new StringDecoder("utf8"),
      stdout: new StringDecoder("utf8"),
    };

    const append = async (target: "stdout" | "stderr", chunk: Buffer) => {
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

      const decoded = outputDecoders[target].write(next);
      for (const output of splitCommandOutputChunks(decoded, 8 * 1024)) {
        await options?.onOutput?.({
          byteLength: Buffer.byteLength(output, "utf8"),
          output: sanitizeExecutionOutput(output, request),
          stream: target,
        });
      }
    };

    const finish = async (
      status: CommandExecutionStatus,
      exitCode?: number | null,
      summaryOverride?: string,
    ) => {
      if (finishing) {
        return;
      }
      finishing = true;
      clearTimeout(timeout);
      options?.signal?.removeEventListener("abort", abort);
      await outputChain;
      for (const target of ["stdout", "stderr"] as const) {
        const decoded = outputDecoders[target].end();
        for (const output of splitCommandOutputChunks(decoded, 8 * 1024)) {
          await options?.onOutput?.({
            byteLength: Buffer.byteLength(output, "utf8"),
            output: sanitizeExecutionOutput(output, request),
            stream: target,
          });
        }
      }
      const durationMs = Date.now() - startedAt;
      const summary =
        summaryOverride ??
        createExecutionSummary({
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
      void onAbortCleanup?.();
      void finish("timed_out", null);
    }, request.timeoutMs);

    const abort = () => {
      const abortReason = String(options?.signal?.reason ?? "");
      const abortStatus =
        options?.abortStatus ??
        (abortReason === "worker_shutdown" || abortReason === "worker_lost"
          ? "failed"
          : "cancelled");
      const abortSummary =
        options?.abortSummary ??
        (abortReason === "worker_shutdown"
          ? "命令 Worker 正在关闭，当前任务已终止且不会自动重试。"
          : abortReason === "worker_lost"
            ? "命令 Worker 失去任务租约，当前任务已终止且不会自动重试。"
            : "命令执行已取消。");
      killChildProcess(child);
      void onAbortCleanup?.();
      void finish(
        abortStatus,
        null,
        abortSummary,
      );
    };
    options?.signal?.addEventListener("abort", abort, { once: true });

    const queueOutput = (
      target: "stdout" | "stderr",
      chunk: Buffer | string,
    ) => {
      const stream = target === "stdout" ? child.stdout : child.stderr;
      stream.pause();
      outputChain = outputChain
        .then(() =>
          append(target, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
        )
        .catch(() => {
          outputTruncated = true;
        })
        .finally(() => {
          if (!finishing) {
            stream.resume();
          }
        });
    };

    child.stdout.on("data", (chunk: Buffer | string) =>
      queueOutput("stdout", chunk),
    );
    child.stderr.on("data", (chunk: Buffer | string) =>
      queueOutput("stderr", chunk),
    );
    child.on("error", () => {
      void finish("failed", null);
    });
    child.on("close", (exitCode) => {
      if (timedOut) {
        return;
      }
      void finish(exitCode === 0 ? "completed" : "failed", exitCode);
    });
  });
}

function createUnavailableResult(
  request: SandboxExecutionRequest,
  backend?: SandboxBackend,
  executionId = `exec:${crypto.randomUUID()}`,
): CommandExecutionResult {
  return {
    args: request.args,
    ...(backend ? { backend } : {}),
    command: request.command,
    cwd: request.cwd,
    durationMs: 0,
    executionId,
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
  status: "failed" | "timed_out" | "cancelled",
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

function createDockerContainerName(executionId: string) {
  const suffix = executionId
    .replace(/[^a-zA-Z0-9_.-]/g, "-")
    .slice(-48);
  return `my-ai-command-${suffix}`;
}

export function splitCommandOutputChunks(value: string, maxBytes: number) {
  if (!value) {
    return [];
  }
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (current && currentBytes + characterBytes > maxBytes) {
      chunks.push(current);
      current = "";
      currentBytes = 0;
    }
    current += character;
    currentBytes += characterBytes;
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

async function removeDockerContainer(
  dockerPath: string,
  containerName: string,
) {
  await new Promise<void>((resolve) => {
    const cleanup: ChildProcess = spawn(
      dockerPath,
      ["rm", "-f", containerName],
      {
      env: {
        ...process.env,
        PATH: SANDBOX_EXECUTION_PATH,
      },
      shell: false,
      stdio: "ignore",
      },
    );
    cleanup.once("error", () => resolve());
    cleanup.once("close", () => resolve());
  });
}
