"use client";

import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import {
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
  type DataMessagePartProps,
  type EmptyMessagePartProps,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import {
  AlertTriangle,
  BarChart3,
  Building2,
  BookOpen,
  Bot,
  Brain,
  CheckCircle2,
  Code2,
  FolderSearch,
  Lightbulb,
  LoaderCircle,
  Mic,
  PanelLeft,
  PenLine,
  Plus,
  RotateCcw,
  Search,
  Send,
  Sparkles,
  SunMedium,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  createTransientThread,
  getThreadTitle,
  loadActiveThreadId,
  loadRepositoryFromServer,
  loadThreadsFromServer,
  saveActiveThreadId,
  type StoredThread,
} from "@/lib/thread-storage";
import type { SupportedAgent } from "@/lib/agent/shared/agent-ids";
import {
  deleteMemoryOnServer,
  loadMemoriesFromServer,
  restoreMemoryOnServer,
  type ClientMemoryListStatus,
  type ClientStoredMemory,
} from "@/lib/memory-client";
import { getThreadPath } from "@/lib/thread-routes";

type Suggestion = {
  label: string;
  icon: typeof SunMedium;
  prompt: string;
  agent?: SupportedAgent;
};

const gatsbyPrompt = `Project Gutenberg hosts a full plain-text copy of F. Scott Fitzgerald's The Great Gatsby.
URL: https://www.gutenberg.org/files/64317/64317-0.txt

Answer as much as you can:

1) How many lines in the complete Gutenberg file contain the substring \`Gatsby\` (count lines, not occurrences within a line, each line ends with a line break).
2) The 1-based line number of the first line in the file that contains \`Daisy\`.
3) A two-sentence neutral synopsis.

Do your best on (1) and (2). If at any point you realize you cannot verify an exact answer with your available tools and reasoning, do not fabricate numbers: use \`null\` for that field and spell out the limitation in \`how_you_computed_counts\`. If you encounter any errors please report what the error was and what the error message was.`;

const suggestions: Suggestion[] = [
  {
    label: "Demo",
    icon: Bot,
    prompt: "现在几点了？请顺带自我介绍一句。",
    agent: "demo",
  },
  {
    label: "Coordinator",
    icon: Sparkles,
    prompt:
      "请先查看我的记忆偏好，再列出当前沙盒 docs 目录，并按偏好总结有哪些文件。",
    agent: "coordinator",
  },
  {
    label: "Weather",
    icon: SunMedium,
    prompt: "What's the weather in San Francisco?",
    agent: "weather",
  },
  {
    label: "Gatsby",
    icon: BookOpen,
    prompt: gatsbyPrompt,
    agent: "literary",
  },
  {
    label: "Files",
    icon: FolderSearch,
    prompt: "请列出当前沙盒目录，并说明可以读取哪些文件。",
    agent: "filesystem",
  },
  {
    label: "Remember",
    icon: Brain,
    prompt: "请记住：我偏好中文回答，回答问题时默认使用中文。",
    agent: "memory",
  },
  {
    label: "Memory",
    icon: BookOpen,
    prompt: "请查看你已经记住的关于我的信息。如果没有记忆，请直接说明还没有。",
    agent: "memory",
  },
  {
    label: "Code",
    icon: Code2,
    prompt: "请帮我实现一个 TypeScript React 组件，并解释关键设计。",
  },
  {
    label: "Write",
    icon: PenLine,
    prompt: "请帮我写一段清晰、专业、可直接发送的中文说明。",
  },
  {
    label: "Analyze",
    icon: BarChart3,
    prompt: "请分析下面的信息，给出结论、证据和风险点。",
  },
  {
    label: "Brainstorm",
    icon: Lightbulb,
    prompt: "请围绕这个目标发散 8 个可执行方案，并按优先级排序。",
  },
];

const modelLabel = process.env.NEXT_PUBLIC_MODEL_LABEL || "GPT-4o Mini";

const memoryStatusTabs = [
  { label: "Active", value: "active" },
  { label: "Replaced", value: "superseded" },
  { label: "Deleted", value: "deleted" },
  { label: "All", value: "all" },
] as const satisfies ReadonlyArray<{
  label: string;
  value: ClientMemoryListStatus;
}>;

const memoryKeyLabels: Record<string, string> = {
  "preference.answer_language": "回答语言",
  "preference.answer_style": "回答风格",
  "profile.current_location": "当前位置",
  "profile.nickname": "称呼",
  general: "通用",
};

const memoryStatusLabels: Record<string, string> = {
  active: "有效",
  deleted: "已删除",
  superseded: "已覆盖",
};

type ChatWorkspaceProps = {
  initialThreadId?: string;
  tenantHashId: string;
};

type SelectThreadOptions = {
  replace?: boolean;
  syncUrl?: boolean;
};

export function ChatWorkspace({
  initialThreadId,
  tenantHashId,
}: ChatWorkspaceProps) {
  return (
    <main className="flex min-h-screen flex-col bg-white text-[#121212]">
      <section className="flex min-h-0 flex-1 p-3 sm:p-4">
        <div className="flex min-h-[calc(100vh-96px)] w-full overflow-hidden rounded-[22px] border border-[#e6e6e6] bg-white shadow-[0_1px_10px_rgba(0,0,0,0.04)]">
          <ChatWorkspaceContent
            initialThreadId={initialThreadId}
            tenantHashId={tenantHashId}
          />
        </div>
      </section>
    </main>
  );
}

function ChatWorkspaceContent({
  initialThreadId,
  tenantHashId,
}: ChatWorkspaceProps) {
  const aui = useAui();
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const pathname = usePathname();
  const router = useRouter();
  const [threads, setThreads] = useState<StoredThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [memoryPanelOpen, setMemoryPanelOpen] = useState(false);
  const switchingRef = useRef(false);
  const previousRunningRef = useRef(false);

  const selectThread = useCallback(
    (threadId: string | null, options: SelectThreadOptions = {}) => {
      setActiveThreadId(threadId);
      saveActiveThreadId(tenantHashId, threadId);

      if (!threadId || options.syncUrl === false) {
        return;
      }

      const nextPath = getThreadPath(tenantHashId, threadId);
      if (pathname === nextPath) {
        return;
      }

      if (options.replace) {
        router.replace(nextPath);
        return;
      }

      router.push(nextPath);
    },
    [pathname, router, tenantHashId],
  );

  const refreshThreads = useCallback(
    async (preferredThreadId: string | null) => {
      const serverThreads = await loadThreadsFromServer(tenantHashId);
      if (serverThreads.length === 0) {
        return;
      }

      setThreads(serverThreads);

      const nextThreadId =
        preferredThreadId &&
        serverThreads.some((thread) => thread.id === preferredThreadId)
          ? preferredThreadId
          : serverThreads[0]?.id ?? null;

      selectThread(nextThreadId, { replace: true });
    },
    [selectThread, tenantHashId],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const serverThreads = await loadThreadsFromServer(tenantHashId);
      if (cancelled) {
        return;
      }

      const savedThreadId = loadActiveThreadId(tenantHashId);
      const savedThreadExists =
        savedThreadId !== null &&
        serverThreads.some((thread) => thread.id === savedThreadId);
      const routeThreadExists =
        initialThreadId !== undefined &&
        serverThreads.some((thread) => thread.id === initialThreadId);

      let initialThreads = serverThreads;
      let nextThreadId: string | null = null;

      if (initialThreadId) {
        nextThreadId = initialThreadId;
        initialThreads = routeThreadExists
          ? serverThreads
          : [
              createTransientThread({ threadId: initialThreadId }),
              ...serverThreads,
            ];
      } else if (savedThreadExists) {
        nextThreadId = savedThreadId;
      } else {
        nextThreadId = serverThreads[0]?.id ?? null;
      }

      if (!nextThreadId) {
        const transientThread = createTransientThread();
        initialThreads = [transientThread];
        nextThreadId = transientThread.id;
      }

      if (cancelled) {
        return;
      }

      setThreads(initialThreads);
      selectThread(nextThreadId, { replace: true });
      setHydrated(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [initialThreadId, selectThread, tenantHashId]);

  useEffect(() => {
    if (!hydrated || !activeThreadId) {
      return;
    }

    let cancelled = false;
    switchingRef.current = true;
    aui.thread().reset();

    void (async () => {
      const serverRepository = await loadRepositoryFromServer(
        tenantHashId,
        activeThreadId,
      );
      if (cancelled) {
        return;
      }

      switchingRef.current = true;
      if (serverRepository) {
        aui.thread().import(serverRepository);
      } else {
        aui.thread().reset();
      }

      queueMicrotask(() => {
        if (!cancelled) {
          switchingRef.current = false;
        }
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [activeThreadId, hydrated, aui, tenantHashId]);

  useEffect(() => {
    if (!hydrated || !activeThreadId) {
      return;
    }

    return aui.subscribe(() => {
      if (switchingRef.current) {
        return;
      }

      const state = aui.thread().getState();

      const nextTitle = getThreadTitle(state.messages);
      setThreads((currentThreads) => {
        const updatedAt = new Date().toISOString();
        const nextThreads = currentThreads.map((thread) =>
          thread.id === activeThreadId && thread.title !== nextTitle
            ? {
                ...thread,
                title: nextTitle,
                updatedAt,
              }
            : thread,
        );

        const changed = nextThreads.some(
          (thread, index) => thread !== currentThreads[index],
        );
        return changed ? nextThreads : currentThreads;
      });
    });
  }, [activeThreadId, hydrated, aui]);

  useEffect(() => {
    if (!hydrated) {
      previousRunningRef.current = isRunning;
      return;
    }

    if (previousRunningRef.current && !isRunning) {
      void refreshThreads(activeThreadId);
    }

    previousRunningRef.current = isRunning;
  }, [activeThreadId, hydrated, isRunning, refreshThreads]);

  const activeThread = useMemo(
    () => threads.find((thread) => thread.id === activeThreadId),
    [activeThreadId, threads],
  );

  const handleNewThread = useCallback(() => {
    const nextThread = createTransientThread();
    switchingRef.current = true;
    aui.thread().reset();
    queueMicrotask(() => {
      switchingRef.current = false;
    });

    setThreads((currentThreads) => [
      nextThread,
      ...currentThreads.filter((thread) => thread.id !== nextThread.id),
    ]);
    selectThread(nextThread.id);
  }, [aui, selectThread]);

  const handleSelectThread = useCallback(
    (threadId: string) => {
      if (threadId === activeThreadId) {
        return;
      }

      selectThread(threadId);
    },
    [activeThreadId, selectThread],
  );

  return (
    <>
      <aside className="hidden w-[252px] shrink-0 flex-col border-r border-[#f0f0f0] bg-[#fcfcfc] p-4 md:flex">
        <div className="mb-8 flex items-center gap-3 px-2 pt-3">
          <Bot size={24} strokeWidth={2.4} />
          <span className="min-w-0">
            <span className="block text-[15px] font-semibold">
              assistant-ui
            </span>
            <span className="block truncate font-mono text-xs text-[#777777]">
              {tenantHashId}
            </span>
          </span>
        </div>

        <button
          className="mb-5 flex h-11 items-center gap-3 rounded-xl bg-[#f3f3f3] px-4 text-[15px] font-medium text-[#202020] transition-colors hover:bg-[#eeeeee]"
          onClick={handleNewThread}
          type="button"
        >
          <Plus size={19} />
          New Thread
        </button>

        <div className="mb-3 px-2 text-xs font-semibold text-[#858585]">
          Earlier
        </div>
        <div className="chat-scrollbar -mx-1 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-1">
          {threads.map((thread) => (
            <button
              key={thread.id}
              className={`truncate rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                thread.id === activeThreadId
                  ? "bg-[#eeeeee] font-medium text-[#121212]"
                  : "text-[#2b2b2b] hover:bg-[#f4f4f4]"
              }`}
              onClick={() => handleSelectThread(thread.id)}
              type="button"
            >
              {thread.title}
            </button>
          ))}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col bg-white">
        <div className="flex h-[60px] shrink-0 items-center justify-between px-5 sm:px-8">
          <div className="flex min-w-0 items-center gap-4">
            <button
              className="grid size-8 place-items-center rounded-md hover:bg-[#f5f5f5]"
              title="Toggle sidebar"
              type="button"
            >
              <PanelLeft size={18} />
            </button>
            <h1 className="truncate text-[16px] font-semibold">
              {activeThread?.title || "New Chat"}
            </h1>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              className="grid size-8 place-items-center rounded-md text-[#7b7b7b] hover:bg-[#f5f5f5]"
              onClick={() => setMemoryPanelOpen(true)}
              title="我的记忆"
              type="button"
            >
              <Brain size={18} />
            </button>
            <Link
              className="grid size-8 place-items-center rounded-md text-[#7b7b7b] hover:bg-[#f5f5f5]"
              href="/switch-tenant"
              title="切换租户"
            >
              <Building2 size={18} />
            </Link>
            <button
              className="grid size-8 place-items-center rounded-md text-[#7b7b7b] hover:bg-[#f5f5f5]"
              title="Share"
              type="button"
            >
              <Sparkles size={18} />
            </button>
          </div>
        </div>

        <Thread />
      </section>

      {memoryPanelOpen && (
        <MemoryPanel
          onClose={() => setMemoryPanelOpen(false)}
          tenantHashId={tenantHashId}
        />
      )}
    </>
  );
}

function MemoryPanel({
  onClose,
  tenantHashId,
}: {
  onClose: () => void;
  tenantHashId: string;
}) {
  const [status, setStatus] = useState<ClientMemoryListStatus>("active");
  const [query, setQuery] = useState("");
  const [memories, setMemories] = useState<ClientStoredMemory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mutatingId, setMutatingId] = useState<string | null>(null);

  const refreshMemories = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setMemories(
        await loadMemoriesFromServer(tenantHashId, {
          query,
          status,
        }),
      );
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "记忆列表加载失败。",
      );
    } finally {
      setLoading(false);
    }
  }, [query, status, tenantHashId]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void refreshMemories();
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [refreshMemories]);

  const handleDeleteMemory = useCallback(
    async (memory: ClientStoredMemory) => {
      if (!window.confirm(`确认删除这条记忆？\n\n${memory.content}`)) {
        return;
      }

      setMutatingId(memory.memoryId);
      setError(null);
      try {
        await deleteMemoryOnServer(tenantHashId, memory.memoryId);
        await refreshMemories();
      } catch (deleteError) {
        setError(
          deleteError instanceof Error ? deleteError.message : "记忆删除失败。",
        );
      } finally {
        setMutatingId(null);
      }
    },
    [refreshMemories, tenantHashId],
  );

  const handleRestoreMemory = useCallback(
    async (memory: ClientStoredMemory) => {
      setMutatingId(memory.memoryId);
      setError(null);
      try {
        await restoreMemoryOnServer(tenantHashId, memory.memoryId);
        await refreshMemories();
      } catch (restoreError) {
        setError(
          restoreError instanceof Error ? restoreError.message : "记忆恢复失败。",
        );
      } finally {
        setMutatingId(null);
      }
    },
    [refreshMemories, tenantHashId],
  );

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/10">
      <aside className="flex h-full w-full max-w-[440px] flex-col border-l border-[#e8e8e8] bg-white shadow-[-8px_0_30px_rgba(0,0,0,0.08)]">
        <div className="flex h-16 shrink-0 items-center justify-between border-b border-[#eeeeee] px-5">
          <div className="flex min-w-0 items-center gap-3">
            <Brain size={20} />
            <div className="min-w-0">
              <div className="text-sm font-semibold text-[#171717]">
                我的记忆
              </div>
              <div className="truncate font-mono text-xs text-[#777777]">
                {tenantHashId}
              </div>
            </div>
          </div>
          <button
            className="grid size-8 place-items-center rounded-md text-[#666666] hover:bg-[#f5f5f5]"
            onClick={onClose}
            title="关闭"
            type="button"
          >
            <X size={17} />
          </button>
        </div>

        <div className="space-y-3 border-b border-[#eeeeee] px-5 py-4">
          <div className="grid grid-cols-4 gap-1 rounded-lg bg-[#f5f5f5] p-1">
            {memoryStatusTabs.map((tab) => (
              <button
                className={`h-8 rounded-md text-xs font-medium transition-colors ${
                  status === tab.value
                    ? "bg-white text-[#111111] shadow-sm"
                    : "text-[#666666] hover:text-[#222222]"
                }`}
                key={tab.value}
                onClick={() => setStatus(tab.value)}
                type="button"
              >
                {tab.label}
              </button>
            ))}
          </div>

          <label className="flex h-10 items-center gap-2 rounded-lg border border-[#e3e3e3] px-3 text-sm">
            <Search className="shrink-0 text-[#777777]" size={16} />
            <input
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-[#9a9a9a]"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索内容、分类或 memory key"
              value={query}
            />
          </label>
        </div>

        <div className="chat-scrollbar min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {error && (
            <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}

          {loading ? (
            <div className="flex items-center gap-2 py-8 text-sm text-[#777777]">
              <LoaderCircle className="animate-spin" size={16} />
              加载记忆中
            </div>
          ) : memories.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[#dddddd] px-4 py-8 text-center text-sm text-[#777777]">
              当前筛选条件下没有记忆。
            </div>
          ) : (
            <div className="space-y-3">
              {memories.map((memory) => (
                <MemoryPanelItem
                  key={memory.memoryId}
                  memory={memory}
                  mutating={mutatingId === memory.memoryId}
                  onDelete={handleDeleteMemory}
                  onRestore={handleRestoreMemory}
                />
              ))}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

function MemoryPanelItem({
  memory,
  mutating,
  onDelete,
  onRestore,
}: {
  memory: ClientStoredMemory;
  mutating: boolean;
  onDelete: (memory: ClientStoredMemory) => void;
  onRestore: (memory: ClientStoredMemory) => void;
}) {
  return (
    <article className="rounded-xl border border-[#e8e8e8] bg-[#fbfbfb] p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <MemoryBadge tone="key">
          {memoryKeyLabels[memory.memoryKey] ?? memory.memoryKey}
        </MemoryBadge>
        <MemoryBadge tone={memory.status}>{memoryStatusLabels[memory.status]}</MemoryBadge>
      </div>

      <p className="whitespace-pre-wrap break-words text-sm leading-6 text-[#222222]">
        {memory.extraction?.value ?? memory.content}
      </p>
      {memory.extraction?.value && (
        <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-5 text-[#666666]">
          原文：{memory.content}
        </p>
      )}

      <div className="mt-3 space-y-1 text-xs leading-5 text-[#777777]">
        <div>分类：{memory.category}</div>
        {memory.extraction && (
          <div>
            提取：{memory.extraction.source} ·{" "}
            {formatMemoryConfidence(memory.extraction.confidence)}
            {memory.extraction.value ? ` · value=${memory.extraction.value}` : ""}
          </div>
        )}
        <div>memory_id：{memory.memoryId}</div>
        {memory.sourceThreadId && <div>来源会话：{memory.sourceThreadId}</div>}
        <div>创建：{formatMemoryDate(memory.createdAt)}</div>
        <div>更新：{formatMemoryDate(memory.updatedAt)}</div>
        {memory.validTo && <div>失效：{formatMemoryDate(memory.validTo)}</div>}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {memory.status === "active" ? (
          <button
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-red-200 bg-white px-2.5 text-xs font-medium text-red-700 transition-colors hover:bg-red-50 disabled:opacity-50"
            disabled={mutating}
            onClick={() => onDelete(memory)}
            type="button"
          >
            <Trash2 size={14} />
            删除
          </button>
        ) : (
          <button
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-emerald-200 bg-white px-2.5 text-xs font-medium text-emerald-700 transition-colors hover:bg-emerald-50 disabled:opacity-50"
            disabled={mutating}
            onClick={() => onRestore(memory)}
            type="button"
          >
            <RotateCcw size={14} />
            恢复
          </button>
        )}
      </div>
    </article>
  );
}

function MemoryBadge({
  children,
  tone,
}: {
  children: ReactNode;
  tone: "active" | "deleted" | "key" | "superseded";
}) {
  const className =
    tone === "active"
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : tone === "deleted"
        ? "border-red-200 bg-red-50 text-red-700"
        : tone === "superseded"
          ? "border-amber-200 bg-amber-50 text-amber-800"
          : "border-zinc-200 bg-white text-zinc-700";

  return (
    <span
      className={`inline-flex h-6 items-center rounded-full border px-2 text-xs font-medium ${className}`}
    >
      {children}
    </span>
  );
}

function formatMemoryDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString("zh-CN", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

function formatMemoryConfidence(value: number) {
  if (!Number.isFinite(value)) {
    return "0%";
  }

  return `${Math.round(Math.min(Math.max(value, 0), 1) * 100)}%`;
}

function Thread() {
  const isEmpty = useAuiState((state) => state.thread.messages.length === 0);

  return (
    <ThreadPrimitive.Root className="relative flex min-h-0 flex-1 flex-col">
      <ThreadPrimitive.Viewport className="chat-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto px-4 sm:px-8">
        <div
          className={`mx-auto flex w-full max-w-[980px] flex-1 flex-col ${
            isEmpty ? "justify-center pb-[18vh]" : "justify-end gap-5 py-8"
          }`}
        >
          {isEmpty ? (
            <EmptyState />
          ) : (
            <ThreadPrimitive.Messages
              components={{
                UserMessage,
                AssistantMessage,
              }}
            />
          )}
        </div>
        {!isEmpty && (
          <ThreadPrimitive.ViewportFooter className="sticky bottom-0 mx-auto w-full max-w-[860px] bg-white pb-5 pt-3">
            <PromptComposer />
          </ThreadPrimitive.ViewportFooter>
        )}
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}

function EmptyState() {
  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col items-center">
      <h2 className="mb-8 text-center text-3xl font-semibold tracking-normal text-[#111111] sm:text-[32px]">
        How can I help you today?
      </h2>
      <PromptComposer />
      <SuggestionBar />
    </div>
  );
}

function PromptComposer() {
  const isRunning = useAuiState((state) => state.thread.isRunning);

  return (
    <ComposerPrimitive.Root className="w-full rounded-[25px] border border-[#e5e5e5] bg-white px-5 py-4 shadow-[0_2px_12px_rgba(0,0,0,0.08)]">
      <ComposerPrimitive.Input
        className="max-h-36 min-h-9 w-full resize-none border-0 bg-transparent text-[15px] leading-7 text-[#1f1f1f] outline-none placeholder:text-[#9b9b9b]"
        placeholder="Send a message... (@ to mention, / for commands)"
        rows={1}
        submitMode="enter"
      />
      <div className="mt-3 flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <button
            className="grid size-8 shrink-0 place-items-center rounded-full hover:bg-[#f4f4f4]"
            title="Add attachment"
            type="button"
          >
            <Plus size={20} />
          </button>
          <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">
            <Sparkles size={18} />
            <span className="truncate">{modelLabel}</span>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            className="grid size-8 place-items-center rounded-full hover:bg-[#f4f4f4]"
            title="Voice input"
            type="button"
          >
            <Mic size={18} />
          </button>
          {isRunning ? (
            <ComposerPrimitive.Cancel className="grid size-10 place-items-center rounded-full bg-[#858585] text-white transition-colors hover:bg-[#6f6f6f]">
              <X size={18} />
            </ComposerPrimitive.Cancel>
          ) : (
            <ComposerPrimitive.Send className="grid size-10 place-items-center rounded-full bg-[#8a8a8a] text-white transition-colors hover:bg-[#6f6f6f] disabled:cursor-not-allowed disabled:opacity-45">
              <Send size={19} />
            </ComposerPrimitive.Send>
          )}
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
}

function SuggestionBar() {
  const aui = useAui();
  const isRunning = useAuiState((state) => state.thread.isRunning);

  return (
    <div className="mt-6 flex flex-wrap justify-center gap-3">
      {suggestions.map(({ label, icon: Icon, prompt, agent }) => (
        <button
          key={label}
          className="flex h-10 items-center gap-2 rounded-full border border-[#ececec] bg-white px-4 text-[14px] font-medium text-[#242424] shadow-[0_1px_4px_rgba(0,0,0,0.03)] transition-colors hover:bg-[#f7f7f7] disabled:cursor-not-allowed disabled:opacity-50"
          disabled={isRunning}
          onClick={() => {
            if (agent) {
              aui.thread().append({
                content: [{ type: "text", text: prompt }],
                runConfig: {
                  custom: {
                    agent,
                  },
                },
              });
              return;
            }

            aui.composer().setText(prompt);
          }}
          type="button"
        >
          <Icon size={17} />
          {label}
        </button>
      ))}
    </div>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="flex w-full justify-end">
      <div className="max-w-[78%] rounded-2xl bg-[#f2f2f2] px-4 py-3 text-[15px] leading-7 text-[#191919]">
        <MessagePrimitive.Parts components={{ Text: MarkdownText }} />
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="flex w-full justify-start">
      <div className="flex max-w-[82%] gap-3">
        <div className="mt-1 grid size-8 shrink-0 place-items-center rounded-full bg-[#111111] text-white">
          <Bot size={17} />
        </div>
        <div className="min-w-0 rounded-2xl bg-white px-1 py-2 text-[15px] leading-7 text-[#181818]">
          <MessagePrimitive.Parts
            components={{
              Text: MarkdownText,
              Empty: AssistantLoading,
              tools: {
                Fallback: ToolCallPart,
              },
              data: {
                by_name: {
                  structured_response: StructuredResponsePart,
                },
              },
            }}
          />
          <MessagePrimitive.Error>
            <div className="mt-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              模型响应失败，请检查本地模型配置或稍后重试。
            </div>
          </MessagePrimitive.Error>
        </div>
      </div>
    </MessagePrimitive.Root>
  );
}

function StructuredResponsePart({ data }: DataMessagePartProps) {
  return (
    <div className="my-3 overflow-hidden rounded-xl border border-[#e3e8ef] bg-[#f8fbff] text-sm text-[#202020]">
      <div className="flex items-center gap-2 border-b border-[#e7edf5] px-3 py-2 font-medium">
        <Code2 size={15} />
        <span>结构化结果</span>
      </div>
      <div className="px-3 py-2">
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-white px-3 py-2 font-mono text-xs leading-5 text-[#333333]">
          {formatToolPayload(data)}
        </pre>
      </div>
    </div>
  );
}

function ToolCallPart({
  approval,
  args,
  argsText,
  isError,
  result,
  respondToApproval,
  status,
  toolName,
}: ToolCallMessagePartProps) {
  const retryInfo = getToolRetryInfo(args);
  const running = status.type === "running";
  const approvalPending =
    approval !== undefined &&
    approval.approved === undefined &&
    approval.resolution === undefined;
  const approvalApproved = approval?.approved === true;
  const approvalRejected = approval?.approved === false;
  const approvalPreview = getApprovalPreview(approval);
  const approvalSubject = getApprovalSubject(toolName, approvalPreview);
  const failed = isError || status.type === "incomplete";
  const Icon =
    approvalPending || approvalRejected || failed
      ? AlertTriangle
      : running
        ? LoaderCircle
        : CheckCircle2;
  let statusText = "完成";
  if (approvalPending) {
    statusText = "待确认";
  } else if (approvalApproved) {
    statusText = "已确认";
  } else if (approvalRejected) {
    statusText = "已取消";
  } else if (running && retryInfo) {
    statusText = `重试 ${retryInfo.attempt}/${retryInfo.maxRetries}`;
  } else if (running) {
    statusText = "运行中";
  } else if (failed) {
    statusText = "失败";
  }
  const displayArgs = argsText || removeToolRetryInfo(args);

  return (
    <div className="my-3 overflow-hidden rounded-xl border border-[#e7e7e7] bg-[#fafafa] text-sm text-[#202020]">
      <div className="flex items-center justify-between gap-3 border-b border-[#eeeeee] px-3 py-2">
        <div className="flex min-w-0 items-center gap-2 font-medium">
          <Wrench size={15} />
          <span className="truncate font-mono text-[13px]">{toolName}</span>
        </div>
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-[#666666]">
          <Icon
            className={running && !approvalPending ? "animate-spin" : undefined}
            size={14}
          />
          {statusText}
        </span>
      </div>
      <div className="space-y-2 px-3 py-2">
        {running && retryInfo && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
            第 {retryInfo.attempt} 次执行失败，约{" "}
            {formatRetryDelay(retryInfo.nextDelayMs)} 后自动重试。
            {retryInfo.error ? ` 原因：${retryInfo.error}` : ""}
          </div>
        )}
        <ToolPayload label="参数" value={displayArgs} />
        {approvalPending && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
            <div className="font-medium">
              该{approvalSubject}需要你确认后才会执行。
            </div>
            {approvalPreview && <ApprovalPreview preview={approvalPreview} />}
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                className="rounded-md bg-[#111111] px-3 py-1.5 font-medium text-white transition-colors hover:bg-[#303030]"
                onClick={() => respondToApproval({ approved: true })}
                type="button"
              >
                确认执行
              </button>
              <button
                className="rounded-md border border-amber-300 bg-white px-3 py-1.5 font-medium text-amber-900 transition-colors hover:bg-amber-100"
                onClick={() =>
                  respondToApproval({
                    approved: false,
                    reason: "用户取消",
                  })
                }
                type="button"
              >
                取消
              </button>
            </div>
          </div>
        )}
        {approvalApproved && result === undefined && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs leading-5 text-emerald-800">
            已确认，服务端会继续执行该{approvalSubject}并返回结果。
          </div>
        )}
        {approvalRejected && (
          <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2 text-xs leading-5 text-zinc-700">
            已取消，本次不会修改{approvalSubject === "文件操作" ? "文件" : "长期记忆"}。
          </div>
        )}
        {!running && !approvalPending && result !== undefined && (
          <ToolPayload label="结果" value={result} />
        )}
      </div>
    </div>
  );
}

type MemoryApprovalPreviewData = {
  category: string;
  content: string;
  extraction: {
    category: string;
    confidence: number;
    key: string;
    reason?: string;
    source: string;
    value: string | null;
  } | null;
  memoryKey: string;
  newValue: string | null;
  replacedMemory: {
    content: string;
    updatedAt?: string;
  } | null;
  replacedValue: string | null;
  willReplace: boolean;
};

type FilesystemApprovalPreviewData =
  | {
      contentPreview: string;
      kind: "write";
      operation: "create" | "overwrite";
      path: string;
      previousSizeBytes?: number;
      sizeBytes: number;
      summary: string;
    }
  | {
      after: string;
      before: string;
      kind: "edit";
      newSizeBytes: number;
      path: string;
      replaceAll: boolean;
      replacements: number;
      sizeBytes: number;
      summary: string;
    }
  | {
      contentPreview?: string;
      kind: "delete";
      path: string;
      sizeBytes: number;
      summary: string;
    };

type ApprovalPreviewData =
  | FilesystemApprovalPreviewData
  | MemoryApprovalPreviewData;

function ApprovalPreview({ preview }: { preview: ApprovalPreviewData }) {
  if (isFilesystemPreview(preview)) {
    return <FilesystemApprovalPreview preview={preview} />;
  }

  return <MemoryApprovalPreview preview={preview} />;
}

function MemoryApprovalPreview({
  preview,
}: {
  preview: MemoryApprovalPreviewData;
}) {
  return (
    <div className="mt-2 space-y-2 rounded-md border border-amber-200 bg-white/70 px-3 py-2">
      <div>
        <span className="font-medium">新记忆：</span>
        {preview.content}
      </div>
      <div>
        <span className="font-medium">memory_key：</span>
        {memoryKeyLabels[preview.memoryKey] ?? preview.memoryKey}
      </div>
      {preview.extraction && (
        <div className="grid gap-1 rounded-md bg-white px-2 py-1.5">
          <div>
            <span className="font-medium">value：</span>
            {preview.extraction.value ?? "未提取"}
          </div>
          <div>
            <span className="font-medium">提取：</span>
            {preview.extraction.source} ·{" "}
            {formatMemoryConfidence(preview.extraction.confidence)}
            {preview.extraction.reason ? ` · ${preview.extraction.reason}` : ""}
          </div>
        </div>
      )}
      {preview.willReplace && preview.replacedMemory ? (
        <div className="rounded-md bg-amber-100/70 px-2 py-1.5">
          <div className="font-medium">将覆盖旧记忆</div>
          <div className="mt-1 text-amber-950">
            值变化：{preview.replacedValue ?? "未提取"} -&gt;{" "}
            {preview.newValue ?? "未提取"}
          </div>
          <div className="mt-1 text-amber-950">
            {preview.replacedMemory.content}
          </div>
          {preview.replacedMemory.updatedAt && (
            <div className="mt-1 text-[11px] text-amber-800">
              更新时间：{formatMemoryDate(preview.replacedMemory.updatedAt)}
            </div>
          )}
        </div>
      ) : (
        <div>不会覆盖现有 active 记忆。</div>
      )}
    </div>
  );
}

function FilesystemApprovalPreview({
  preview,
}: {
  preview: FilesystemApprovalPreviewData;
}) {
  return (
    <div className="mt-2 space-y-2 rounded-md border border-amber-200 bg-white/70 px-3 py-2">
      <div>
        <span className="font-medium">操作：</span>
        {getFilesystemPreviewActionLabel(preview)}
      </div>
      <div>
        <span className="font-medium">路径：</span>
        {preview.path}
      </div>
      <div>
        <span className="font-medium">大小：</span>
        {formatBytes(preview.sizeBytes)}
        {preview.kind === "write" && preview.previousSizeBytes !== undefined
          ? `，原大小 ${formatBytes(preview.previousSizeBytes)}`
          : ""}
        {preview.kind === "edit"
          ? ` -> ${formatBytes(preview.newSizeBytes)}`
          : ""}
      </div>
      {preview.kind === "edit" && (
        <div className="grid gap-2">
          <div>
            <div className="mb-1 font-medium">替换前</div>
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md bg-white px-2 py-1.5 font-mono text-[11px] leading-5 text-amber-950">
              {preview.before}
            </pre>
          </div>
          <div>
            <div className="mb-1 font-medium">替换后</div>
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md bg-white px-2 py-1.5 font-mono text-[11px] leading-5 text-amber-950">
              {preview.after}
            </pre>
          </div>
          <div>
            替换次数：{preview.replacements}
            {preview.replaceAll ? "（全部匹配）" : "（唯一匹配）"}
          </div>
        </div>
      )}
      {preview.kind !== "edit" && preview.contentPreview && (
        <div>
          <div className="mb-1 font-medium">
            {preview.kind === "delete" ? "将删除内容预览" : "写入内容预览"}
          </div>
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md bg-white px-2 py-1.5 font-mono text-[11px] leading-5 text-amber-950">
            {preview.contentPreview}
          </pre>
        </div>
      )}
    </div>
  );
}

function getApprovalPreview(approval: unknown): ApprovalPreviewData | null {
  if (!isPlainRecord(approval) || !isPlainRecord(approval.preview)) {
    return null;
  }

  const preview = approval.preview;
  const filesystemPreview = parseFilesystemApprovalPreview(preview);
  if (filesystemPreview) {
    return filesystemPreview;
  }

  const replacedMemory = isPlainRecord(preview.replacedMemory)
    ? {
        content:
          typeof preview.replacedMemory.content === "string"
            ? preview.replacedMemory.content
            : "",
        updatedAt:
          typeof preview.replacedMemory.updatedAt === "string"
            ? preview.replacedMemory.updatedAt
            : undefined,
      }
    : null;

  const content = typeof preview.content === "string" ? preview.content : "";
  const memoryKey =
    typeof preview.memoryKey === "string" ? preview.memoryKey : "general";
  const extraction = parseApprovalExtraction(preview.extraction);
  if (!content) {
    return null;
  }

  return {
    category: typeof preview.category === "string" ? preview.category : "general",
    content,
    extraction,
    memoryKey,
    newValue: typeof preview.newValue === "string" ? preview.newValue : null,
    replacedMemory,
    replacedValue:
      typeof preview.replacedValue === "string" ? preview.replacedValue : null,
    willReplace: preview.willReplace === true,
  };
}

function parseApprovalExtraction(
  value: unknown,
): MemoryApprovalPreviewData["extraction"] {
  if (!isPlainRecord(value)) {
    return null;
  }

  return {
    category: typeof value.category === "string" ? value.category : "general",
    confidence:
      typeof value.confidence === "number" ? value.confidence : 0,
    key: typeof value.key === "string" ? value.key : "general",
    reason: typeof value.reason === "string" ? value.reason : undefined,
    source: typeof value.source === "string" ? value.source : "rule",
    value: typeof value.value === "string" ? value.value : null,
  };
}

function parseFilesystemApprovalPreview(
  preview: Record<string, unknown>,
): FilesystemApprovalPreviewData | null {
  const kind = typeof preview.kind === "string" ? preview.kind : "";
  const path = typeof preview.path === "string" ? preview.path : "";
  const sizeBytes =
    typeof preview.sizeBytes === "number" ? preview.sizeBytes : undefined;
  const summary = typeof preview.summary === "string" ? preview.summary : "";
  if (!path || sizeBytes === undefined || !summary) {
    return null;
  }

  if (kind === "write") {
    const operation =
      preview.operation === "overwrite" ? "overwrite" : "create";
    return {
      contentPreview:
        typeof preview.contentPreview === "string" ? preview.contentPreview : "",
      kind,
      operation,
      path,
      previousSizeBytes:
        typeof preview.previousSizeBytes === "number"
          ? preview.previousSizeBytes
          : undefined,
      sizeBytes,
      summary,
    };
  }

  if (kind === "edit") {
    if (
      typeof preview.before !== "string" ||
      typeof preview.after !== "string" ||
      typeof preview.newSizeBytes !== "number" ||
      typeof preview.replacements !== "number"
    ) {
      return null;
    }

    return {
      after: preview.after,
      before: preview.before,
      kind,
      newSizeBytes: preview.newSizeBytes,
      path,
      replaceAll: preview.replaceAll === true,
      replacements: preview.replacements,
      sizeBytes,
      summary,
    };
  }

  if (kind === "delete") {
    return {
      kind,
      path,
      sizeBytes,
      summary,
      ...(typeof preview.contentPreview === "string"
        ? { contentPreview: preview.contentPreview }
        : {}),
    };
  }

  return null;
}

function getApprovalSubject(
  toolName: string,
  preview: ApprovalPreviewData | null,
) {
  if (
    (preview && isFilesystemPreview(preview)) ||
    toolName === "write_file" ||
    toolName === "edit_file" ||
    toolName === "delete_file"
  ) {
    return "文件操作";
  }

  return "记忆操作";
}

function isFilesystemPreview(
  preview: ApprovalPreviewData,
): preview is FilesystemApprovalPreviewData {
  return (
    "kind" in preview &&
    (preview.kind === "write" ||
      preview.kind === "edit" ||
      preview.kind === "delete")
  );
}

function getFilesystemPreviewActionLabel(
  preview: FilesystemApprovalPreviewData,
) {
  if (preview.kind === "write") {
    return preview.operation === "create" ? "创建文件" : "覆盖文件";
  }

  if (preview.kind === "edit") {
    return "编辑文件";
  }

  return "删除文件";
}

function formatBytes(sizeBytes: number) {
  return `${sizeBytes} bytes`;
}

type ToolRetryInfo = {
  attempt: number;
  error?: string;
  maxRetries: number;
  nextDelayMs: number;
};

function getToolRetryInfo(args: unknown): ToolRetryInfo | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return null;
  }

  const retry = (args as { __retry?: unknown }).__retry;
  if (!retry || typeof retry !== "object" || Array.isArray(retry)) {
    return null;
  }

  const candidate = retry as Partial<ToolRetryInfo>;
  if (
    typeof candidate.attempt !== "number" ||
    typeof candidate.maxRetries !== "number" ||
    typeof candidate.nextDelayMs !== "number"
  ) {
    return null;
  }

  return {
    attempt: candidate.attempt,
    error: typeof candidate.error === "string" ? candidate.error : undefined,
    maxRetries: candidate.maxRetries,
    nextDelayMs: candidate.nextDelayMs,
  };
}

function removeToolRetryInfo(args: unknown) {
  if (!isPlainRecord(args)) {
    return args;
  }

  const rest = { ...args };
  delete rest.__retry;
  return rest;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function formatRetryDelay(delayMs: number) {
  if (delayMs < 1000) {
    return `${delayMs}ms`;
  }

  return `${(delayMs / 1000).toFixed(1)}s`;
}

function ToolPayload({ label, value }: { label: string; value: unknown }) {
  const text = formatToolPayload(value);

  if (!text) {
    return null;
  }

  return (
    <div>
      <div className="mb-1 text-xs font-medium text-[#777777]">{label}</div>
      <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-white px-3 py-2 font-mono text-xs leading-5 text-[#333333]">
        {text}
      </pre>
    </div>
  );
}

function formatToolPayload(value: unknown) {
  if (value === undefined || value === null || value === "") {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function MarkdownText() {
  return (
    <MarkdownTextPrimitive
      className="prose prose-neutral max-w-none text-[15px] leading-7"
      components={{
        p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
        ul: ({ children }) => (
          <ul className="mb-3 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>
        ),
        ol: ({ children }) => (
          <ol className="mb-3 list-decimal space-y-1 pl-5 last:mb-0">
            {children}
          </ol>
        ),
        code: ({ children }) => (
          <code className="rounded bg-[#f3f3f3] px-1.5 py-0.5 font-mono text-[0.92em]">
            {children}
          </code>
        ),
      }}
    />
  );
}

function AssistantLoading({ status }: EmptyMessagePartProps) {
  if (status.type !== "running") {
    return null;
  }

  return (
    <div className="flex items-center gap-2 py-1 text-sm text-[#777777]">
      <span className="size-2 animate-pulse rounded-full bg-[#999999]" />
      Thinking
    </div>
  );
}
