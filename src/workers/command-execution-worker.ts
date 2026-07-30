import os from "node:os";
import type { CommandExecutionResult } from "@/lib/command-execution/contracts";
import { executeCommandInSandbox } from "@/lib/command-execution/execution-service";
import {
  appendCommandOutput,
  claimNextCommandExecution,
  cleanupCommandExecutionRetention,
  expireQueuedCommandExecutions,
  failLostCommandExecutions,
  finalizeCommandExecution,
  heartbeatCommandWorker,
  isCommandExecutionCancelRequested,
  registerCommandWorker,
  renewCommandExecutionLease,
  unregisterCommandWorker,
  type ClaimedCommandExecution,
} from "@/lib/command-execution/execution-repository";

const HEARTBEAT_MS = 5_000;
const CONTROL_POLL_MS = 500;
const IDLE_POLL_MS = 500;
const CLEANUP_MS = 60 * 60 * 1000;

const concurrency = normalizeConcurrency(
  process.env.COMMAND_WORKER_CONCURRENCY,
);
const workerId = `${os.hostname()}:${process.pid}:${crypto.randomUUID()}`;
const activeControllers = new Map<string, AbortController>();
let shuttingDown = false;

await registerCommandWorker(workerId, concurrency);
await failLostCommandExecutions();
await expireQueuedCommandExecutions();

const heartbeatTimer = setInterval(() => {
  void heartbeatCommandWorker(workerId).catch(logWorkerError);
}, HEARTBEAT_MS);
const cleanupTimer = setInterval(() => {
  void runMaintenance().catch(logWorkerError);
}, CLEANUP_MS);

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.once("SIGINT", () => {
  void shutdown("SIGINT");
});

console.info(
  `[command-worker] started workerId=${workerId} concurrency=${concurrency}`,
);

await Promise.all(
  Array.from({ length: concurrency }, (_, index) => runLane(index)),
);
clearInterval(heartbeatTimer);
clearInterval(cleanupTimer);
await unregisterCommandWorker(workerId).catch(logWorkerError);
console.info(`[command-worker] stopped workerId=${workerId}`);

async function runLane(lane: number) {
  while (!shuttingDown) {
    try {
      const execution = await claimNextCommandExecution(workerId);
      if (!execution) {
        await delay(IDLE_POLL_MS);
        continue;
      }
      await runExecution(execution);
    } catch (error) {
      console.error(`[command-worker] lane=${lane} failed`, error);
      await delay(IDLE_POLL_MS);
    }
  }
}

async function runExecution(execution: ClaimedCommandExecution) {
  const controller = new AbortController();
  activeControllers.set(execution.executionId, controller);
  let lastLeaseRenewedAt = 0;
  const controlTimer = setInterval(() => {
    void (async () => {
      if (controller.signal.aborted) {
        return;
      }
      if (shuttingDown) {
        controller.abort("worker_shutdown");
        return;
      }
      if (
        await isCommandExecutionCancelRequested(
          workerId,
          execution.executionId,
        )
      ) {
        controller.abort("cancel_requested");
        return;
      }
      const now = Date.now();
      if (now - lastLeaseRenewedAt >= HEARTBEAT_MS) {
        lastLeaseRenewedAt = now;
        const renewed = await renewCommandExecutionLease(
          workerId,
          execution.executionId,
        );
        if (!renewed) {
          controller.abort("worker_lost");
        }
      }
    })().catch((error) => {
      console.error(
        `[command-worker] control poll failed executionId=${execution.executionId}`,
        error,
      );
      controller.abort("worker_lost");
    });
  }, CONTROL_POLL_MS);

  try {
    const toolResult = await executeCommandInSandbox(
      {
        args: execution.args,
        command: execution.command,
        cwd: execution.cwd,
        timeoutMs: execution.timeoutMs,
      },
      {
        threadId: execution.threadId,
        threadScope: {
          tenantHashId: execution.tenantHashId,
          userHashId: execution.userHashId,
          workspaceId: execution.workspaceId,
        },
      },
      undefined,
      {
        executionId: execution.executionId,
        onOutput: (chunk) =>
          appendCommandOutput(execution.executionId, chunk),
        signal: controller.signal,
      },
    );
    const result =
      toolResult.commandResult ??
      createWorkerFailureResult(execution, toolResult.summary);
    const abortReason = controller.signal.aborted
      ? String(controller.signal.reason)
      : undefined;
    await finalizeCommandExecution(
      execution,
      result,
      abortReason === "worker_shutdown" || abortReason === "worker_lost"
        ? abortReason
        : undefined,
    );
  } finally {
    clearInterval(controlTimer);
    activeControllers.delete(execution.executionId);
  }
}

async function runMaintenance() {
  await heartbeatCommandWorker(workerId);
  await failLostCommandExecutions();
  await expireQueuedCommandExecutions();
  await cleanupCommandExecutionRetention();
}

async function shutdown(signal: string) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.info(
    `[command-worker] received ${signal}; stopping claims and terminating ${activeControllers.size} executions`,
  );
  for (const controller of activeControllers.values()) {
    controller.abort("worker_shutdown");
  }
}

function createWorkerFailureResult(
  execution: ClaimedCommandExecution,
  summary: string,
): CommandExecutionResult {
  return {
    args: execution.args,
    command: execution.command,
    cwd: execution.cwd,
    durationMs: execution.startedAt
      ? Math.max(0, Date.now() - new Date(execution.startedAt).getTime())
      : 0,
    executionId: execution.executionId,
    finishedAt: new Date().toISOString(),
    outputTruncated: execution.outputTruncated,
    status: "failed",
    stderr: execution.stderr,
    stdout: execution.stdout,
    summary,
  };
}

function normalizeConcurrency(value: string | undefined) {
  const parsed = Number(value ?? "2");
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 16 ? parsed : 2;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function logWorkerError(error: unknown) {
  console.error("[command-worker]", error);
}
