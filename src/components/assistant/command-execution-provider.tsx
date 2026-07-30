"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from "react";
import {
  isCommandExecutionSnapshot,
  isCommandExecutionTerminalStatus,
  isPersistedCommandExecutionEvent,
  reduceCommandExecutionEvent,
  type CommandExecutionSnapshot,
  type PersistedCommandExecutionEvent,
} from "@/lib/command-execution/contracts";

type CommandExecutionContextValue = {
  cancel: (executionId: string) => Promise<void>;
  error: string | null;
  executions: CommandExecutionSnapshot[];
  mutatingExecutionId: string | null;
  poke: () => void;
  retry: (executionId: string) => Promise<void>;
};

const CommandExecutionContext =
  createContext<CommandExecutionContextValue | null>(null);

// 存在非终态任务时按 ACTIVE 频率轮询快照，全部终态 / 无任务时退避到 IDLE 频率。
// 用户批准新命令时通过 poke() 立即刷新，因此 IDLE 可以放心设得很低频。
const ACTIVE_POLL_MS = 1_500;
const IDLE_POLL_MS = 20_000;
// poke() 后维持快频轮询的窗口，用于可靠抓到刚入队、尚未出现在快照里的新任务。
const POKE_FAST_WINDOW_MS = 8_000;

export function CommandExecutionProvider({
  children,
  tenantHashId,
  threadId,
  workspaceId,
}: PropsWithChildren<{
  tenantHashId: string;
  threadId: string | null;
  workspaceId: string;
}>) {
  const [executions, setExecutions] = useState<
    Map<string, CommandExecutionSnapshot>
  >(new Map());
  const [error, setError] = useState<string | null>(null);
  const [mutatingExecutionId, setMutatingExecutionId] = useState<string | null>(
    null,
  );
  const cursorsRef = useRef(new Map<string, string>());
  const streamsRef = useRef(new Map<string, AbortController>());
  const hasActiveRef = useRef(false);
  const pokeUntilRef = useRef(0);
  const runNowRef = useRef<() => void>(() => {});

  const refresh = useCallback(async () => {
    if (!threadId) {
      setExecutions(new Map());
      return;
    }
    const response = await fetch(
      executionUrl(tenantHashId, "/chat/executions", {
        threadId,
        workspaceId,
      }),
      { cache: "no-store" },
    );
    if (!response.ok) {
      throw new Error(await readErrorMessage(response));
    }
    const body = (await response.json()) as { executions?: unknown };
    const snapshots = Array.isArray(body.executions)
      ? body.executions.filter(isCommandExecutionSnapshot)
      : [];
    setExecutions(new Map(snapshots.map((item) => [item.executionId, item])));
    for (const snapshot of snapshots) {
      if (snapshot.lastEventId) {
        cursorsRef.current.set(snapshot.executionId, snapshot.lastEventId);
      }
    }
    setError(null);
  }, [tenantHashId, threadId, workspaceId]);

  useEffect(() => {
    const streams = streamsRef.current;
    for (const controller of streams.values()) {
      controller.abort();
    }
    streams.clear();
    cursorsRef.current.clear();
    if (!threadId) {
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        await refresh();
      } catch (refreshError) {
        if (!cancelled) {
          setError(toErrorMessage(refreshError));
        }
      }
      if (cancelled) {
        return;
      }
      const fast =
        hasActiveRef.current || Date.now() < pokeUntilRef.current;
      timer = setTimeout(() => void tick(), fast ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    };
    // poke()：批准新命令等时机下强制立即刷新并维持一段快频轮询窗口。
    runNowRef.current = () => {
      if (cancelled) {
        return;
      }
      pokeUntilRef.current = Date.now() + POKE_FAST_WINDOW_MS;
      clearTimeout(timer);
      void tick();
    };
    void tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      runNowRef.current = () => {};
      for (const controller of streams.values()) {
        controller.abort();
      }
      streams.clear();
    };
  }, [refresh, threadId]);

  useEffect(() => {
    hasActiveRef.current = [...executions.values()].some(
      (execution) => !isCommandExecutionTerminalStatus(execution.status),
    );
  }, [executions]);

  useEffect(() => {
    if (!threadId) {
      return;
    }
    for (const execution of executions.values()) {
      if (
        isCommandExecutionTerminalStatus(execution.status) ||
        streamsRef.current.has(execution.executionId)
      ) {
        continue;
      }
      const controller = new AbortController();
      streamsRef.current.set(execution.executionId, controller);
      void subscribeToExecution({
        applyEvent: (event) => {
          cursorsRef.current.set(execution.executionId, event.id);
          setExecutions((current) =>
            applyPersistedEvent(current, execution.executionId, event),
          );
        },
        cursor: () =>
          cursorsRef.current.get(execution.executionId) ??
          execution.lastEventId ??
          "0",
        executionId: execution.executionId,
        signal: controller.signal,
        tenantHashId,
        threadId,
        workspaceId,
      })
        .catch((streamError) => {
          if (!controller.signal.aborted) {
            setError(toErrorMessage(streamError));
          }
        })
        .finally(() => {
          if (streamsRef.current.get(execution.executionId) === controller) {
            streamsRef.current.delete(execution.executionId);
          }
        });
    }
    for (const [executionId, controller] of streamsRef.current) {
      const execution = executions.get(executionId);
      if (!execution || isCommandExecutionTerminalStatus(execution.status)) {
        controller.abort();
        streamsRef.current.delete(executionId);
      }
    }
  }, [executions, tenantHashId, threadId, workspaceId]);

  const mutate = useCallback(
    async (executionId: string, operation: "cancel" | "retry") => {
      if (!threadId) {
        return;
      }
      setMutatingExecutionId(executionId);
      setError(null);
      try {
        const response = await fetch(
          executionUrl(
            tenantHashId,
            `/chat/executions/${encodeURIComponent(executionId)}/${operation}`,
          ),
          {
            body: JSON.stringify({ threadId, workspaceId }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          },
        );
        if (!response.ok) {
          throw new Error(await readErrorMessage(response));
        }
        const body = (await response.json()) as {
          commandExecution?: unknown;
        };
        if (isCommandExecutionSnapshot(body.commandExecution)) {
          const snapshot = body.commandExecution;
          setExecutions((current) => {
            const next = new Map(current);
            next.set(snapshot.executionId, snapshot);
            return next;
          });
        }
        await refresh();
      } catch (mutationError) {
        setError(toErrorMessage(mutationError));
      } finally {
        setMutatingExecutionId(null);
      }
    },
    [refresh, tenantHashId, threadId, workspaceId],
  );

  const poke = useCallback(() => {
    runNowRef.current();
  }, []);

  const value = useMemo<CommandExecutionContextValue>(
    () => ({
      cancel: (executionId) => mutate(executionId, "cancel"),
      error,
      executions: [...executions.values()],
      mutatingExecutionId,
      poke,
      retry: (executionId) => mutate(executionId, "retry"),
    }),
    [error, executions, mutate, mutatingExecutionId, poke],
  );

  return (
    <CommandExecutionContext.Provider value={value}>
      {children}
    </CommandExecutionContext.Provider>
  );
}

export function useCommandExecution(toolCallId: string) {
  const context = useContext(CommandExecutionContext);
  const execution = useMemo(
    () =>
      context?.executions
        .filter((candidate) => candidate.toolCallId === toolCallId)
        .sort((left, right) => right.attempt - left.attempt)[0] ?? null,
    [context?.executions, toolCallId],
  );
  return {
    cancel: context?.cancel,
    error: context?.error ?? null,
    execution,
    mutating:
      execution !== null &&
      context?.mutatingExecutionId === execution.executionId,
    poke: context?.poke,
    retry: context?.retry,
  };
}

async function subscribeToExecution({
  applyEvent,
  cursor,
  executionId,
  signal,
  tenantHashId,
  threadId,
  workspaceId,
}: {
  applyEvent: (event: PersistedCommandExecutionEvent) => void;
  cursor: () => string;
  executionId: string;
  signal: AbortSignal;
  tenantHashId: string;
  threadId: string;
  workspaceId: string;
}) {
  while (!signal.aborted) {
    const response = await fetch(
      executionUrl(
        tenantHashId,
        `/chat/executions/${encodeURIComponent(executionId)}/events`,
        {
          after: cursor(),
          threadId,
          workspaceId,
        },
      ),
      {
        cache: "no-store",
        headers: { "Last-Event-ID": cursor() },
        signal,
      },
    );
    if (!response.ok) {
      throw new Error(await readErrorMessage(response));
    }
    if (!response.body) {
      throw new Error("命令事件流没有返回可读内容。");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      const parsed = consumeSseBuffer(buffer);
      buffer = parsed.remaining;
      parsed.events.forEach(applyEvent);
    }
  }
}

function consumeSseBuffer(buffer: string) {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const blocks = normalized.split("\n\n");
  const remaining = blocks.pop() ?? "";
  const events = blocks.flatMap((block) => {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data) {
      return [];
    }
    try {
      const value = JSON.parse(data);
      return isPersistedCommandExecutionEvent(value) ? [value] : [];
    } catch {
      return [];
    }
  });
  return { events, remaining };
}

function applyPersistedEvent(
  current: Map<string, CommandExecutionSnapshot>,
  executionId: string,
  persisted: PersistedCommandExecutionEvent,
) {
  const next = new Map(current);
  const event = persisted.event;
  const execution = next.get(executionId);
  if (execution) {
    next.set(executionId, reduceCommandExecutionEvent(execution, persisted));
    return next;
  }
  if (event.type === "command_state" || event.type === "command_result") {
    next.set(executionId, {
      ...event.execution,
      lastEventId: persisted.id,
    });
    return next;
  }
  return current;
}

function executionUrl(
  tenantHashId: string,
  suffix: string,
  query?: Record<string, string>,
) {
  const search = query ? `?${new URLSearchParams(query)}` : "";
  return `/api/tenants/${encodeURIComponent(tenantHashId)}${suffix}${search}`;
}

async function readErrorMessage(response: Response) {
  try {
    const body = (await response.json()) as {
      error?: { message?: string };
    };
    return body.error?.message || `命令执行接口失败：HTTP ${response.status}`;
  } catch {
    return `命令执行接口失败：HTTP ${response.status}`;
  }
}

function toErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "命令执行请求失败。";
}
