import { isCommandExecutionTerminalStatus } from "@/lib/command-execution/contracts";
import {
  CommandExecutionStoreError,
  getCommandExecution,
  listCommandExecutionEvents,
} from "@/lib/command-execution/execution-service";
import {
  executionErrorResponse,
  normalizeExecutionScopeInput,
  resolveCommandExecutionAccess,
} from "@/lib/server/command-execution-access";

type RouteContext = {
  params: Promise<{ executionId: string; tenantId: string }>;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();
const POLL_MS = 500;
const HEARTBEAT_MS = 15_000;

export async function GET(request: Request, context: RouteContext) {
  const { executionId, tenantId } = await context.params;
  const url = new URL(request.url);
  const input = normalizeExecutionScopeInput(
    url.searchParams.get("threadId"),
    url.searchParams.get("workspaceId"),
  );
  if (!input) {
    return executionErrorResponse(
      "invalid_execution_scope",
      "缺少 threadId 或 workspaceId。",
      400,
    );
  }
  const access = await resolveCommandExecutionAccess({ tenantId, ...input });
  if (!access.ok) {
    return access.response;
  }

  let initialExecution;
  try {
    initialExecution = await getCommandExecution(
      access.scope,
      input.threadId,
      executionId,
    );
  } catch (error) {
    return storeErrorResponse(error);
  }
  if (!initialExecution) {
    return executionErrorResponse(
      "execution_not_found",
      "命令执行任务不存在或不属于当前作用域。",
      404,
    );
  }

  const after = normalizeEventId(
    url.searchParams.get("after") ?? request.headers.get("Last-Event-ID"),
  );
  if (after === null) {
    return executionErrorResponse(
      "invalid_event_cursor",
      "after 或 Last-Event-ID 必须是非负整数。",
      400,
    );
  }

  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
    start(controller) {
      void pumpEvents({
        after,
        controller,
        executionId,
        isCancelled: () => cancelled,
        scope: access.scope,
        threadId: input.threadId,
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    },
  });
}

async function pumpEvents({
  after,
  controller,
  executionId,
  isCancelled,
  scope,
  threadId,
}: {
  after: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  executionId: string;
  isCancelled: () => boolean;
  scope: {
    tenantHashId: string;
    userHashId: string;
    workspaceId: string;
  };
  threadId: string;
}) {
  let cursor = after;
  let lastHeartbeatAt = Date.now();
  try {
    while (!isCancelled()) {
      const events = await listCommandExecutionEvents(scope, {
        afterEventId: cursor,
        executionId,
        threadId,
      });
      for (const event of events) {
        controller.enqueue(
          encoder.encode(
            `id: ${event.id}\nevent: ${event.event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          ),
        );
        cursor = event.id;
      }

      const execution = await getCommandExecution(
        scope,
        threadId,
        executionId,
      );
      if (
        !execution ||
        (isCommandExecutionTerminalStatus(execution.status) &&
          (!execution.lastEventId ||
            BigInt(cursor) >= BigInt(execution.lastEventId)))
      ) {
        controller.close();
        return;
      }

      if (Date.now() - lastHeartbeatAt >= HEARTBEAT_MS) {
        controller.enqueue(encoder.encode(": heartbeat\n\n"));
        lastHeartbeatAt = Date.now();
      }
      await delay(POLL_MS);
    }
  } catch (error) {
    if (!isCancelled()) {
      controller.error(error);
    }
  }
}

function normalizeEventId(value: string | null) {
  if (value === null || value === "") {
    return "0";
  }
  return /^\d+$/.test(value) ? value : null;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function storeErrorResponse(error: unknown) {
  if (error instanceof CommandExecutionStoreError) {
    return executionErrorResponse(error.code, error.message, error.status);
  }
  return executionErrorResponse(
    "execution_events_failed",
    "订阅命令执行事件失败。",
    500,
  );
}
