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
  Circle,
  Code2,
  FileMinus2,
  FilePenLine,
  FilePlus2,
  FolderSearch,
  GitBranch,
  Lightbulb,
  ListChecks,
  LoaderCircle,
  Mic,
  PanelLeft,
  PenLine,
  Plus,
  RotateCcw,
  Search,
  Send,
  Sparkles,
  Terminal,
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
  saveRepositoryToServer,
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
import {
  getNewWorkspacePath,
  getThreadPath,
  getWorkspacePath,
} from "@/lib/thread-routes";
import {
  loadWorkspacesFromServer,
  type ClientWorkspace,
} from "@/lib/workspace-client";
import {
  CommandExecutionProvider,
  useCommandExecution,
} from "@/components/assistant/command-execution-provider";
import {
  isCommandExecutionTerminalStatus,
  type CommandExecutionSnapshot,
} from "@/lib/command-execution/contracts";

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
  workspaceId: string;
};

type SelectThreadOptions = {
  replace?: boolean;
  syncUrl?: boolean;
};

export function ChatWorkspace({
  initialThreadId,
  tenantHashId,
  workspaceId,
}: ChatWorkspaceProps) {
  return (
    <main className="flex h-dvh min-h-0 flex-col overflow-hidden bg-white text-[#121212]">
      <section className="flex min-h-0 flex-1 p-3 sm:p-4">
        <div className="relative flex min-h-0 flex-1 overflow-hidden rounded-[22px] border border-[#e6e6e6] bg-white shadow-[0_1px_10px_rgba(0,0,0,0.04)]">
          <ChatWorkspaceContent
            initialThreadId={initialThreadId}
            tenantHashId={tenantHashId}
            workspaceId={workspaceId}
          />
        </div>
      </section>
    </main>
  );
}

function ChatWorkspaceContent({
  initialThreadId,
  tenantHashId,
  workspaceId,
}: ChatWorkspaceProps) {
  const aui = useAui();
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const pathname = usePathname();
  const router = useRouter();
  const [threads, setThreads] = useState<StoredThread[]>([]);
  const [workspaces, setWorkspaces] = useState<ClientWorkspace[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [memoryPanelOpen, setMemoryPanelOpen] = useState(false);
  const [desktopSidebarOpen, setDesktopSidebarOpen] = useState(true);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const switchingRef = useRef(false);
  const previousRunningRef = useRef(false);

  const selectThread = useCallback(
    (threadId: string | null, options: SelectThreadOptions = {}) => {
      setActiveThreadId(threadId);
      saveActiveThreadId(tenantHashId, workspaceId, threadId);

      if (!threadId || options.syncUrl === false) {
        return;
      }

      const nextPath = getThreadPath(tenantHashId, threadId, workspaceId);
      if (pathname === nextPath) {
        return;
      }

      if (options.replace) {
        router.replace(nextPath);
        return;
      }

      router.push(nextPath);
    },
    [pathname, router, tenantHashId, workspaceId],
  );

  const refreshThreads = useCallback(
    async (preferredThreadId: string | null) => {
      const serverThreads = await loadThreadsFromServer(tenantHashId, workspaceId);
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
    [selectThread, tenantHashId, workspaceId],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [workspaceResult, threadResult] = await Promise.allSettled([
        loadWorkspacesFromServer(tenantHashId),
        loadThreadsFromServer(tenantHashId, workspaceId),
      ]);
      if (cancelled) {
        return;
      }

      const workspaceData =
        workspaceResult.status === "fulfilled"
          ? workspaceResult.value
          : { workspaces: [], defaultWorkspaceId: workspaceId };
      const serverThreads =
        threadResult.status === "fulfilled" ? threadResult.value : [];

      setWorkspaces(workspaceData.workspaces);
      const savedThreadId = loadActiveThreadId(tenantHashId, workspaceId);
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
  }, [initialThreadId, selectThread, tenantHashId, workspaceId]);

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
        workspaceId,
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
  }, [activeThreadId, hydrated, aui, tenantHashId, workspaceId]);

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

    if (previousRunningRef.current && !isRunning && activeThreadId) {
      const repository = aui.thread().export();
      void (async () => {
        try {
          await saveRepositoryToServer({
            repository,
            tenantHashId,
            workspaceId,
            threadId: activeThreadId,
          });
        } catch {
          // 线程文本已由服务端保存；这里失败只影响 tool/data 卡片恢复。
        } finally {
          await refreshThreads(activeThreadId);
        }
      })();
    }

    previousRunningRef.current = isRunning;
  }, [
    activeThreadId,
    hydrated,
    isRunning,
    refreshThreads,
    aui,
    tenantHashId,
    workspaceId,
  ]);

  const activeThread = useMemo(
    () => threads.find((thread) => thread.id === activeThreadId),
    [activeThreadId, threads],
  );

  const handleNewThread = useCallback(() => {
    const nextThread = createTransientThread();
    setMobileSidebarOpen(false);
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
        setMobileSidebarOpen(false);
        return;
      }

      setMobileSidebarOpen(false);
      selectThread(threadId);
    },
    [activeThreadId, selectThread],
  );

  const handleToggleSidebar = useCallback(() => {
    if (window.matchMedia("(min-width: 48rem)").matches) {
      setDesktopSidebarOpen((open) => !open);
      return;
    }

    setMobileSidebarOpen((open) => !open);
  }, []);

  return (
    <>
      {mobileSidebarOpen && (
        <button
          aria-label="关闭侧栏"
          className="absolute inset-0 z-10 bg-black/20 md:hidden"
          onClick={() => setMobileSidebarOpen(false)}
          type="button"
        />
      )}
      <aside
        className={`min-h-0 w-[252px] shrink-0 flex-col border-r border-[#f0f0f0] bg-[#fcfcfc] p-4 max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-20 max-md:shadow-xl ${
          mobileSidebarOpen ? "max-md:flex" : "max-md:hidden"
        } ${desktopSidebarOpen ? "md:flex" : "md:hidden"}`}
        id="chat-sidebar"
      >
        <div className="mb-8 flex items-center justify-between gap-3 px-2 pt-3">
          <span className="flex min-w-0 items-center gap-3">
            <Bot className="shrink-0" size={24} strokeWidth={2.4} />
            <span className="min-w-0">
              <span className="block text-[15px] font-semibold">
                assistant-ui
              </span>
              <span className="block truncate font-mono text-xs text-[#777777]">
                {tenantHashId}
              </span>
            </span>
          </span>
          <button
            aria-label="关闭侧栏"
            className="grid size-8 shrink-0 place-items-center rounded-md hover:bg-[#eaeaea] md:hidden"
            onClick={() => setMobileSidebarOpen(false)}
            title="关闭侧栏"
            type="button"
          >
            <X size={18} />
          </button>
        </div>

        <button
          className="mb-5 flex h-11 items-center gap-3 rounded-xl bg-[#f3f3f3] px-4 text-[15px] font-medium text-[#202020] transition-colors hover:bg-[#eeeeee]"
          onClick={handleNewThread}
          type="button"
        >
          <Plus size={19} />
          新建对话
        </button>

        <div className="mb-5 px-1">
          <span className="mb-2 block px-1 text-xs font-semibold text-[#858585]">
            工作区
          </span>
          <select
            className="h-10 w-full rounded-lg border border-[#e6e6e6] bg-white px-3 text-sm text-[#252525] outline-none transition-colors focus:border-[#bdbdbd]"
            onChange={(event) => {
              if (event.target.value !== workspaceId) {
                router.push(getWorkspacePath(tenantHashId, event.target.value));
              }
            }}
            value={workspaceId}
          >
            {workspaces.length === 0 ? (
              <option value={workspaceId}>当前工作区</option>
            ) : (
              workspaces.map((workspace) => (
                <option key={workspace.workspaceId} value={workspace.workspaceId}>
                  {workspace.name}
                </option>
              ))
            )}
          </select>
          <Link
            className="mt-2 flex h-9 items-center justify-center gap-2 rounded-lg border border-dashed border-[#d8d8d8] text-sm font-medium text-[#555555] transition-colors hover:border-[#999999] hover:bg-white"
            href={getNewWorkspacePath(tenantHashId)}
          >
            <Plus size={15} />
            新建工作区
          </Link>
        </div>

        <div className="mb-3 px-2 text-xs font-semibold text-[#858585]">
          历史对话
        </div>
        <div className="chat-scrollbar -mx-1 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-1">
          {threads.map((thread) => (
            <button
              key={thread.id}
              className={`w-full min-w-0 shrink-0 truncate rounded-lg px-3 py-2 text-left text-sm transition-colors ${
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

      <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-white">
        <div className="flex h-[60px] shrink-0 items-center justify-between px-5 sm:px-8">
          <div className="flex min-w-0 items-center gap-4">
            <button
              aria-controls="chat-sidebar"
              className="grid size-8 place-items-center rounded-md hover:bg-[#f5f5f5]"
              onClick={handleToggleSidebar}
              title="展开或收起侧栏"
              type="button"
            >
              <PanelLeft size={18} />
            </button>
            <h1 className="truncate text-[16px] font-semibold">
              {activeThread?.title || "新建对话"}
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

        <CommandExecutionProvider
          tenantHashId={tenantHashId}
          threadId={activeThreadId}
          workspaceId={workspaceId}
        >
          <Thread />
        </CommandExecutionProvider>
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
                  agent_retry: AgentRetryPart,
                  command_result: CommandResultPart,
                  filesystem_change: FilesystemChangePart,
                  structured_response: StructuredResponsePart,
                  subagent_state: SubagentStatePart,
                  todo_state: TodoStatePart,
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

type TodoStateData = {
  agentId: string;
  revision: number;
  todos: Array<{
    content: string;
    id: string;
    status: "pending" | "in_progress" | "completed";
  }>;
  updatedAt: string;
};

type AgentRetryData = {
  attempt: number;
  completedToolCallCount: number;
  lastToolCall?: {
    toolCallId: string;
    toolName: string;
  };
  maxAttempts: number;
  reason: string;
  recovery: "checkpoint";
};

function AgentRetryPart({ data }: DataMessagePartProps) {
  const retry = parseAgentRetry(data);
  if (!retry) {
    return null;
  }

  const toolLabel = retry.lastToolCall
    ? `工具 ${retry.lastToolCall.toolName} 完成后`
    : `${retry.completedToolCallCount} 个工具完成后`;

  return (
    <div className="my-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm leading-6 text-amber-950">
      <div className="flex items-center gap-2 font-medium">
        <RotateCcw size={15} />
        <span>已从 checkpoint 重试</span>
        <span className="text-xs font-normal text-amber-800">
          {retry.attempt}/{retry.maxAttempts}
        </span>
      </div>
      <div className="mt-1 text-[13px] leading-5 text-amber-900">
        模型在{toolLabel}继续生成时失败，已触发 checkpoint 恢复。
      </div>
      <div className="mt-1 break-words rounded-lg border border-amber-200 bg-white/70 px-2 py-1 font-mono text-xs leading-5 text-amber-900">
        {retry.reason}
      </div>
    </div>
  );
}

function parseAgentRetry(data: unknown): AgentRetryData | null {
  if (!isPlainRecord(data)) {
    return null;
  }

  const lastToolCall = isPlainRecord(data.lastToolCall)
    ? data.lastToolCall
    : undefined;
  if (
    typeof data.attempt !== "number" ||
    typeof data.completedToolCallCount !== "number" ||
    typeof data.maxAttempts !== "number" ||
    typeof data.reason !== "string" ||
    data.recovery !== "checkpoint"
  ) {
    return null;
  }

  let parsedLastToolCall: AgentRetryData["lastToolCall"];
  if (lastToolCall) {
    if (
      typeof lastToolCall.toolCallId !== "string" ||
      typeof lastToolCall.toolName !== "string"
    ) {
      return null;
    }

    parsedLastToolCall = {
      toolCallId: lastToolCall.toolCallId,
      toolName: lastToolCall.toolName,
    };
  }

  return {
    attempt: data.attempt,
    completedToolCallCount: data.completedToolCallCount,
    ...(parsedLastToolCall
      ? {
          lastToolCall: parsedLastToolCall,
        }
      : {}),
    maxAttempts: data.maxAttempts,
    reason: data.reason,
    recovery: "checkpoint",
  };
}

type SubagentStateData = {
  agent: "filesystem" | "memory" | "weather";
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

function SubagentStatePart({ data }: DataMessagePartProps) {
  const subagent = parseSubagentState(data);
  if (!subagent) {
    return null;
  }

  const status = getSubagentStatusView(subagent.status);
  const StatusIcon = status.icon;
  const agentLabel = getSubagentLabel(subagent.agent);

  return (
    <article
      aria-live="polite"
      className="my-3 overflow-hidden rounded-xl border border-violet-200 bg-violet-50/60 text-sm text-violet-950"
    >
      <div className="flex items-center justify-between gap-3 border-b border-violet-100 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2 font-medium">
          <GitBranch size={15} />
          <span>{agentLabel} 子 Agent</span>
        </div>
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-violet-800">
          <StatusIcon
            className={subagent.status === "running" ? "animate-spin" : undefined}
            size={14}
          />
          {status.label}
        </span>
      </div>
      <div className="space-y-1.5 px-3 py-2 text-[13px] leading-5">
        <div className="break-words font-medium">{subagent.taskSummary}</div>
        {subagent.summary && (
          <div className="break-words text-violet-900">{subagent.summary}</div>
        )}
        {subagent.error && (
          <div className="break-words rounded-lg border border-red-200 bg-red-50 px-2 py-1 text-red-800">
            {subagent.error}
          </div>
        )}
        {subagent.durationMs !== undefined && (
          <div className="text-xs text-violet-700">
            耗时 {formatDuration(subagent.durationMs)}
          </div>
        )}
      </div>
    </article>
  );
}

function parseSubagentState(data: unknown): SubagentStateData | null {
  if (!isPlainRecord(data)) {
    return null;
  }

  const status =
    data.status === "running" ||
    data.status === "completed" ||
    data.status === "failed"
      ? data.status
      : null;
  const agent =
    data.agent === "filesystem" ||
    data.agent === "memory" ||
    data.agent === "weather"
      ? data.agent
      : null;
  if (
    !agent ||
    !status ||
    typeof data.parentAgentId !== "string" ||
    typeof data.startedAt !== "string" ||
    typeof data.subtaskId !== "string" ||
    typeof data.taskSummary !== "string"
  ) {
    return null;
  }

  if (
    data.durationMs !== undefined &&
    (typeof data.durationMs !== "number" || !Number.isFinite(data.durationMs))
  ) {
    return null;
  }

  return {
    agent,
    ...(typeof data.durationMs === "number"
      ? { durationMs: data.durationMs }
      : {}),
    ...(typeof data.error === "string" ? { error: data.error } : {}),
    ...(typeof data.finishedAt === "string"
      ? { finishedAt: data.finishedAt }
      : {}),
    parentAgentId: data.parentAgentId,
    startedAt: data.startedAt,
    status,
    subtaskId: data.subtaskId,
    ...(typeof data.summary === "string" ? { summary: data.summary } : {}),
    taskSummary: data.taskSummary,
  };
}

function getSubagentStatusView(status: SubagentStateData["status"]) {
  if (status === "completed") {
    return { icon: CheckCircle2, label: "已完成" };
  }
  if (status === "failed") {
    return { icon: AlertTriangle, label: "失败" };
  }
  return { icon: LoaderCircle, label: "执行中" };
}

function getSubagentLabel(agent: SubagentStateData["agent"]) {
  if (agent === "filesystem") {
    return "文件系统";
  }
  if (agent === "memory") {
    return "记忆";
  }
  return "天气";
}

type FilesystemChangeData = {
  approvalId?: string;
  changeId: string;
  operation: "create" | "overwrite" | "edit" | "delete";
  path: string;
  replacements?: number;
  sizeBytes?: number;
  status: "completed" | "rejected" | "failed";
  summary: string;
  toolCallId?: string;
};

type CommandResultData = {
  args: string[];
  command: string;
  cwd: string;
  durationMs: number;
  executionId: string;
  exitCode?: number | null;
  outputTruncated: boolean;
  status:
    | "completed"
    | "failed"
    | "timed_out"
    | "rejected"
    | "sandbox_unavailable"
    | "cancelled"
    | "expired";
  stderr: string;
  stdout: string;
  summary: string;
};

function CommandResultPart({ data }: DataMessagePartProps) {
  const result = parseCommandResult(data);
  if (!result) {
    return null;
  }

  const status = getCommandStatusView(result.status);
  const StatusIcon = status.icon;
  const commandText = [result.command, ...result.args].join(" ");

  return (
    <article
      aria-live="polite"
      className="my-3 overflow-hidden rounded-xl border border-emerald-200 bg-emerald-50/60 text-sm text-emerald-950"
    >
      <div className="flex items-center justify-between gap-3 border-b border-emerald-100 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2 font-medium">
          <Terminal size={15} />
          <span>命令执行</span>
        </div>
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-emerald-800">
          <StatusIcon size={14} />
          {status.label}
        </span>
      </div>
      <div className="space-y-2 px-3 py-2 text-[13px] leading-5">
        <code className="block break-all rounded-lg bg-white/80 px-2 py-1 font-mono text-xs text-emerald-950">
          {commandText}
        </code>
        <div className="text-xs text-emerald-700">
          工作目录：{result.cwd} · 耗时 {formatDuration(result.durationMs)}
          {result.exitCode !== undefined && ` · exit code ${result.exitCode ?? "-"}`}
        </div>
        <div className="break-words text-emerald-900">{result.summary}</div>
        {result.stdout && (
          <details className="rounded-lg border border-emerald-100 bg-white/80">
            <summary className="cursor-pointer px-2 py-1 text-xs font-medium">
              标准输出
            </summary>
            <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words border-t border-emerald-100 px-2 py-2 font-mono text-xs leading-5">
              {result.stdout}
            </pre>
          </details>
        )}
        {result.stderr && (
          <details className="rounded-lg border border-red-100 bg-red-50/70">
            <summary className="cursor-pointer px-2 py-1 text-xs font-medium text-red-800">
              标准错误
            </summary>
            <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words border-t border-red-100 px-2 py-2 font-mono text-xs leading-5 text-red-800">
              {result.stderr}
            </pre>
          </details>
        )}
        {result.outputTruncated && (
          <div className="text-xs text-amber-700">输出已截断。</div>
        )}
      </div>
    </article>
  );
}

function parseCommandResult(data: unknown): CommandResultData | null {
  if (!isPlainRecord(data)) {
    return null;
  }

  const validStatus =
    data.status === "completed" ||
    data.status === "failed" ||
    data.status === "timed_out" ||
    data.status === "rejected" ||
    data.status === "sandbox_unavailable" ||
    data.status === "cancelled" ||
    data.status === "expired";
  if (
    !validStatus ||
    !Array.isArray(data.args) ||
    !data.args.every((arg) => typeof arg === "string") ||
    typeof data.command !== "string" ||
    typeof data.cwd !== "string" ||
    typeof data.durationMs !== "number" ||
    !Number.isFinite(data.durationMs) ||
    typeof data.executionId !== "string" ||
    typeof data.outputTruncated !== "boolean" ||
    typeof data.stderr !== "string" ||
    typeof data.stdout !== "string" ||
    typeof data.summary !== "string"
  ) {
    return null;
  }

  if (
    data.exitCode !== undefined &&
    data.exitCode !== null &&
    typeof data.exitCode !== "number"
  ) {
    return null;
  }

  const commandStatus = data.status as CommandResultData["status"];
  return {
    args: data.args,
    command: data.command,
    cwd: data.cwd,
    durationMs: data.durationMs,
    executionId: data.executionId,
    ...(data.exitCode !== undefined ? { exitCode: data.exitCode } : {}),
    outputTruncated: data.outputTruncated,
    status: commandStatus,
    stderr: data.stderr,
    stdout: data.stdout,
    summary: data.summary,
  };
}

function getCommandStatusView(status: CommandResultData["status"]) {
  if (status === "completed") {
    return { icon: CheckCircle2, label: "已完成" };
  }
  if (status === "timed_out") {
    return { icon: AlertTriangle, label: "执行超时" };
  }
  if (status === "rejected") {
    return { icon: AlertTriangle, label: "已拒绝" };
  }
  if (status === "sandbox_unavailable") {
    return { icon: AlertTriangle, label: "Sandbox 不可用" };
  }
  if (status === "cancelled") {
    return { icon: X, label: "已取消" };
  }
  if (status === "expired") {
    return { icon: AlertTriangle, label: "已过期" };
  }
  return { icon: AlertTriangle, label: "执行失败" };
}

function FilesystemChangePart({ data }: DataMessagePartProps) {
  const change = parseFilesystemChange(data);
  if (!change) {
    return null;
  }

  const operation = getFilesystemOperationView(change.operation);
  const status = getFilesystemChangeStatusView(change.status);
  const OperationIcon = operation.icon;
  const StatusIcon = status.icon;

  return (
    <article className="my-3 overflow-hidden rounded-xl border border-sky-200 bg-sky-50/60 text-sm text-sky-950">
      <div className="flex items-center justify-between gap-3 border-b border-sky-100 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2 font-medium">
          <OperationIcon size={15} />
          <span>{operation.label}</span>
        </div>
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-sky-800">
          <StatusIcon size={14} />
          {status.label}
        </span>
      </div>
      <div className="space-y-1.5 px-3 py-2 text-[13px] leading-5">
        <code className="block break-all rounded-lg bg-white/80 px-2 py-1 text-xs text-sky-950">
          {change.path}
        </code>
        <div className="break-words text-sky-900">{change.summary}</div>
        {(change.sizeBytes !== undefined || change.replacements !== undefined) && (
          <div className="text-xs text-sky-700">
            {change.sizeBytes !== undefined && `大小 ${change.sizeBytes} bytes`}
            {change.sizeBytes !== undefined && change.replacements !== undefined && " · "}
            {change.replacements !== undefined && `替换 ${change.replacements} 次`}
          </div>
        )}
      </div>
    </article>
  );
}

function parseFilesystemChange(data: unknown): FilesystemChangeData | null {
  if (!isPlainRecord(data)) {
    return null;
  }

  const operation =
    data.operation === "create" ||
    data.operation === "overwrite" ||
    data.operation === "edit" ||
    data.operation === "delete"
      ? data.operation
      : null;
  const status =
    data.status === "completed" ||
    data.status === "rejected" ||
    data.status === "failed"
      ? data.status
      : null;
  if (
    !operation ||
    !status ||
    typeof data.changeId !== "string" ||
    typeof data.path !== "string" ||
    typeof data.summary !== "string"
  ) {
    return null;
  }

  if (
    (data.sizeBytes !== undefined &&
      (typeof data.sizeBytes !== "number" || !Number.isFinite(data.sizeBytes))) ||
    (data.replacements !== undefined &&
      (typeof data.replacements !== "number" ||
        !Number.isFinite(data.replacements)))
  ) {
    return null;
  }

  return {
    ...(typeof data.approvalId === "string"
      ? { approvalId: data.approvalId }
      : {}),
    changeId: data.changeId,
    operation,
    path: data.path,
    ...(typeof data.replacements === "number"
      ? { replacements: data.replacements }
      : {}),
    ...(typeof data.sizeBytes === "number"
      ? { sizeBytes: data.sizeBytes }
      : {}),
    status,
    summary: data.summary,
    ...(typeof data.toolCallId === "string"
      ? { toolCallId: data.toolCallId }
      : {}),
  };
}

function getFilesystemOperationView(
  operation: FilesystemChangeData["operation"],
) {
  if (operation === "create") {
    return { icon: FilePlus2, label: "创建文件" };
  }
  if (operation === "overwrite") {
    return { icon: FilePlus2, label: "覆盖文件" };
  }
  if (operation === "edit") {
    return { icon: FilePenLine, label: "编辑文件" };
  }
  return { icon: FileMinus2, label: "删除文件" };
}

function getFilesystemChangeStatusView(
  status: FilesystemChangeData["status"],
) {
  if (status === "completed") {
    return { icon: CheckCircle2, label: "已完成" };
  }
  if (status === "rejected") {
    return { icon: AlertTriangle, label: "已拒绝" };
  }
  return { icon: AlertTriangle, label: "执行失败" };
}

function formatDuration(value: number) {
  if (value < 1_000) {
    return `${Math.max(0, Math.round(value))} ms`;
  }
  return `${(value / 1_000).toFixed(1)} s`;
}

function TodoStatePart({ data }: DataMessagePartProps) {
  const state = parseTodoState(data);
  if (!state) {
    return null;
  }

  const completedCount = state.todos.filter(
    (todo) => todo.status === "completed",
  ).length;

  return (
    <div className="my-3 overflow-hidden rounded-xl border border-[#dfe8e3] bg-[#fbfdfb] text-sm text-[#202020]">
      <div className="flex items-center justify-between gap-3 border-b border-[#e7eee9] px-3 py-2">
        <div className="flex min-w-0 items-center gap-2 font-medium">
          <ListChecks size={15} />
          <span>任务进度</span>
        </div>
        <span className="shrink-0 text-xs text-[#66756b]">
          {completedCount}/{state.todos.length}
        </span>
      </div>
      <ol className="space-y-2 px-3 py-2">
        {state.todos.map((todo) => {
          const status = getTodoStatusView(todo.status);
          const Icon = status.icon;

          return (
            <li key={todo.id} className="flex min-w-0 items-start gap-2">
              <Icon
                className={`mt-1 shrink-0 ${status.className}`}
                size={14}
              />
              <span
                className={`min-w-0 flex-1 break-words text-[13px] leading-5 ${
                  todo.status === "completed"
                    ? "text-[#66756b] line-through decoration-[#9cb3a4]"
                    : "text-[#1f2a22]"
                }`}
              >
                {todo.content}
              </span>
              <span className="shrink-0 rounded-full border border-[#dfe8e3] bg-white px-2 py-0.5 text-[11px] leading-4 text-[#66756b]">
                {status.label}
              </span>
            </li>
          );
        })}
      </ol>
      <div className="border-t border-[#e7eee9] px-3 py-1.5 text-[11px] leading-4 text-[#7a857d]">
        revision {state.revision} · {formatMemoryDate(state.updatedAt)}
      </div>
    </div>
  );
}

function parseTodoState(data: unknown): TodoStateData | null {
  if (!isPlainRecord(data)) {
    return null;
  }

  if (
    typeof data.agentId !== "string" ||
    typeof data.revision !== "number" ||
    typeof data.updatedAt !== "string" ||
    !Array.isArray(data.todos)
  ) {
    return null;
  }

  const todos = data.todos.flatMap((todo) => {
    if (!isPlainRecord(todo)) {
      return [];
    }

    const status: TodoStateData["todos"][number]["status"] | null =
      todo.status === "pending" ||
      todo.status === "in_progress" ||
      todo.status === "completed"
        ? todo.status
        : null;
    if (
      typeof todo.id !== "string" ||
      typeof todo.content !== "string" ||
      !status
    ) {
      return [];
    }

    return [
      {
        content: todo.content,
        id: todo.id,
        status,
      },
    ];
  });

  return {
    agentId: data.agentId,
    revision: data.revision,
    todos,
    updatedAt: data.updatedAt,
  };
}

function getTodoStatusView(status: TodoStateData["todos"][number]["status"]) {
  if (status === "completed") {
    return {
      className: "text-emerald-600",
      icon: CheckCircle2,
      label: "完成",
    };
  }

  if (status === "in_progress") {
    return {
      className: "animate-spin text-blue-600",
      icon: LoaderCircle,
      label: "进行中",
    };
  }

  return {
    className: "text-[#98a39b]",
    icon: Circle,
    label: "待处理",
  };
}

function ToolCallPart({
  approval,
  args,
  argsText,
  isError,
  result,
  respondToApproval,
  status,
  toolCallId,
  toolName,
}: ToolCallMessagePartProps) {
  const [argsEditorOpen, setArgsEditorOpen] = useState(false);
  const [argsDraft, setArgsDraft] = useState(() => formatToolPayload(args));
  const [guidanceEditorOpen, setGuidanceEditorOpen] = useState(false);
  const [guidanceDraft, setGuidanceDraft] = useState("");
  const [approvalFormError, setApprovalFormError] = useState<string | null>(
    null,
  );
  const retryInfo = getToolRetryInfo(args);
  const commandExecution = useCommandExecution(toolCallId);
  const running = status.type === "running";
  const approvalPending =
    approval !== undefined &&
    approval.approved === undefined &&
    approval.resolution === undefined;
  const approvalApproved = approval?.approved === true;
  const approvalRejected = approval?.approved === false;
  const approvalPreview = getApprovalPreview(approval);
  const approvalSubject = getApprovalSubject(toolName, approvalPreview);
  const approvalOptions = approval?.options ?? [];
  const canEditArgs = hasApprovalOption(approvalOptions, "edit-and-execute");
  const canProvideGuidance = hasApprovalOption(
    approvalOptions,
    "provide-guidance",
  );
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
    statusText = running ? "执行中" : "已完成";
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
        {toolName === "execute_command" && commandExecution.execution && (
          <CommandExecutionCard state={commandExecution} />
        )}
        {approvalPending && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
            <div className="font-medium">
              该{approvalSubject}需要你确认后才会执行。
            </div>
            {approvalPreview && <ApprovalPreview preview={approvalPreview} />}
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                className="rounded-md bg-[#111111] px-3 py-1.5 font-medium text-white transition-colors hover:bg-[#303030]"
                onClick={() => {
                  respondToApproval({
                    approved: true,
                    optionId: "approve-once",
                  });
                  if (toolName === "execute_command") {
                    commandExecution.poke?.();
                  }
                }}
                type="button"
              >
                确认执行
              </button>
              {canEditArgs && (
                <button
                  className="rounded-md border border-sky-300 bg-white px-3 py-1.5 font-medium text-sky-900 transition-colors hover:bg-sky-50"
                  onClick={() => {
                    setApprovalFormError(null);
                    setArgsEditorOpen((open) => !open);
                  }}
                  type="button"
                >
                  修改参数
                </button>
              )}
              {canProvideGuidance && (
                <button
                  className="rounded-md border border-violet-300 bg-white px-3 py-1.5 font-medium text-violet-900 transition-colors hover:bg-violet-50"
                  onClick={() => {
                    setApprovalFormError(null);
                    setGuidanceEditorOpen((open) => !open);
                  }}
                  type="button"
                >
                  提供指导
                </button>
              )}
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
            {argsEditorOpen && canEditArgs && (
              <div className="mt-3 space-y-2 rounded-lg border border-sky-200 bg-sky-50 p-3">
                <label className="block text-xs font-medium text-sky-950">
                  修改后的 JSON 参数
                  <textarea
                    aria-label="修改后的 JSON 参数"
                    className="mt-1 min-h-32 w-full resize-y rounded-md border border-sky-200 bg-white px-2 py-1.5 font-mono text-[11px] leading-5 text-sky-950 outline-none focus:border-sky-400"
                    onChange={(event) => setArgsDraft(event.target.value)}
                    value={argsDraft}
                  />
                </label>
                <button
                  className="rounded-md bg-sky-700 px-3 py-1.5 font-medium text-white transition-colors hover:bg-sky-800"
                  onClick={() => {
                    try {
                      const editedArgs = JSON.parse(argsDraft) as unknown;
                      if (!isPlainRecord(editedArgs)) {
                        setApprovalFormError("参数必须是 JSON 对象。");
                        return;
                      }

                      respondToApproval({
                        approved: true,
                        optionId: "edit-and-execute",
                        reason: JSON.stringify({
                          args: editedArgs,
                          version: 1,
                        }),
                      });
                      if (toolName === "execute_command") {
                        commandExecution.poke?.();
                      }
                    } catch {
                      setApprovalFormError("JSON 参数格式不正确。");
                    }
                  }}
                  type="button"
                >
                  修改参数并执行
                </button>
              </div>
            )}
            {guidanceEditorOpen && canProvideGuidance && (
              <div className="mt-3 space-y-2 rounded-lg border border-violet-200 bg-violet-50 p-3">
                <label className="block text-xs font-medium text-violet-950">
                  给 Agent 的指导
                  <textarea
                    aria-label="给 Agent 的指导"
                    className="mt-1 min-h-20 w-full resize-y rounded-md border border-violet-200 bg-white px-2 py-1.5 text-xs leading-5 text-violet-950 outline-none focus:border-violet-400"
                    maxLength={2000}
                    onChange={(event) => setGuidanceDraft(event.target.value)}
                    placeholder="例如：不要删除原文件，请先创建备份。"
                    value={guidanceDraft}
                  />
                </label>
                <button
                  className="rounded-md bg-violet-700 px-3 py-1.5 font-medium text-white transition-colors hover:bg-violet-800"
                  onClick={() => {
                    const guidance = guidanceDraft.trim();
                    if (!guidance) {
                      setApprovalFormError("指导内容不能为空。");
                      return;
                    }

                    respondToApproval({
                      approved: false,
                      optionId: "provide-guidance",
                      reason: guidance,
                    });
                  }}
                  type="button"
                >
                  提交指导
                </button>
              </div>
            )}
            {approvalFormError && (
              <div className="mt-2 text-xs text-red-700" role="alert">
                {approvalFormError}
              </div>
            )}
          </div>
        )}
        {approvalApproved && running && (
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

function CommandExecutionCard({
  state,
}: {
  state: ReturnType<typeof useCommandExecution>;
}) {
  const execution = state.execution;
  if (!execution) {
    return null;
  }
  const view = getPersistentCommandStatusView(execution.status);
  const StatusIcon = view.icon;
  const active =
    execution.status === "queued" ||
    execution.status === "running" ||
    execution.status === "cancel_requested";
  const retryable =
    isCommandExecutionTerminalStatus(execution.status) &&
    execution.status !== "completed" &&
    execution.attempt < execution.maxAttempts;

  return (
    <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 px-3 py-2 text-xs text-emerald-950">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 font-medium">
          <StatusIcon
            className={execution.status === "running" ? "animate-spin" : undefined}
            size={14}
          />
          {view.label} · 第 {execution.attempt}/{execution.maxAttempts} 次执行
        </span>
        <span className="font-mono text-[11px] text-emerald-700">
          {execution.executionId}
        </span>
      </div>
      <code className="mt-2 block break-all rounded-md bg-white/80 px-2 py-1 font-mono text-[11px]">
        {[execution.command, ...execution.args].join(" ")}
      </code>
      <div className="mt-1 text-[11px] text-emerald-700">
        工作目录：{execution.cwd}
        {execution.result
          ? ` · 耗时 ${formatDuration(execution.result.durationMs)}`
          : ""}
      </div>
      <div className="mt-1 break-words">{execution.summary}</div>
      {execution.stdout && (
        <details
          className="mt-2 rounded-md border border-emerald-100 bg-white/80"
          open={active}
        >
          <summary className="cursor-pointer px-2 py-1 font-medium">
            标准输出
          </summary>
          <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words border-t border-emerald-100 px-2 py-2 font-mono text-[11px] leading-5">
            {execution.stdout}
          </pre>
        </details>
      )}
      {execution.stderr && (
        <details className="mt-2 rounded-md border border-red-100 bg-red-50/80">
          <summary className="cursor-pointer px-2 py-1 font-medium text-red-800">
            标准错误
          </summary>
          <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words border-t border-red-100 px-2 py-2 font-mono text-[11px] leading-5 text-red-800">
            {execution.stderr}
          </pre>
        </details>
      )}
      {execution.outputTruncated && (
        <div className="mt-2 text-amber-700">
          输出达到 128 KiB 上限，后续内容已截断。
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        {active && execution.status !== "cancel_requested" && state.cancel && (
          <button
            className="rounded-md border border-red-200 bg-white px-2.5 py-1 font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
            disabled={state.mutating}
            onClick={() => void state.cancel?.(execution.executionId)}
            type="button"
          >
            {state.mutating ? "处理中…" : "取消执行"}
          </button>
        )}
        {retryable && state.retry && (
          <button
            className="rounded-md border border-emerald-300 bg-white px-2.5 py-1 font-medium text-emerald-800 hover:bg-emerald-50 disabled:opacity-50"
            disabled={state.mutating}
            onClick={() => void state.retry?.(execution.executionId)}
            type="button"
          >
            {state.mutating ? "处理中…" : "重新执行"}
          </button>
        )}
      </div>
      {state.error && (
        <div className="mt-2 rounded-md bg-red-50 px-2 py-1 text-red-700">
          {state.error}
        </div>
      )}
    </div>
  );
}

function getPersistentCommandStatusView(
  status: CommandExecutionSnapshot["status"],
) {
  if (status === "queued") {
    return { icon: Circle, label: "排队中" };
  }
  if (status === "running") {
    return { icon: LoaderCircle, label: "执行中" };
  }
  if (status === "cancel_requested") {
    return { icon: LoaderCircle, label: "正在取消" };
  }
  if (status === "completed") {
    return { icon: CheckCircle2, label: "已完成" };
  }
  if (status === "timed_out") {
    return { icon: AlertTriangle, label: "执行超时" };
  }
  if (status === "sandbox_unavailable") {
    return { icon: AlertTriangle, label: "Sandbox 不可用" };
  }
  if (status === "cancelled") {
    return { icon: X, label: "已取消" };
  }
  if (status === "expired") {
    return { icon: AlertTriangle, label: "已过期" };
  }
  return { icon: AlertTriangle, label: "执行失败" };
}

function hasApprovalOption(
  options: readonly { id: string }[],
  optionId: string,
) {
  return options.some((option) => option.id === optionId);
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

type CommandApprovalPreviewData = {
  args: string[];
  command: string;
  cwd: string;
  filesystem: "read-only";
  kind: "command";
  network: "disabled";
  summary: string;
  timeoutMs: number;
};

type ApprovalPreviewData =
  | CommandApprovalPreviewData
  | FilesystemApprovalPreviewData
  | MemoryApprovalPreviewData;

function ApprovalPreview({ preview }: { preview: ApprovalPreviewData }) {
  if (isCommandPreview(preview)) {
    return <CommandApprovalPreview preview={preview} />;
  }
  if (isFilesystemPreview(preview)) {
    return <FilesystemApprovalPreview preview={preview} />;
  }

  return <MemoryApprovalPreview preview={preview} />;
}

function CommandApprovalPreview({
  preview,
}: {
  preview: CommandApprovalPreviewData;
}) {
  return (
    <div className="mt-2 space-y-2 rounded-md border border-amber-200 bg-white/70 px-3 py-2">
      <div>
        <span className="font-medium">命令：</span>
        <code className="font-mono">
          {[preview.command, ...preview.args].join(" ")}
        </code>
      </div>
      <div>
        <span className="font-medium">工作目录：</span>
        {preview.cwd}
      </div>
      <div>
        文件系统只读 · 网络关闭 · 超时 {formatDuration(preview.timeoutMs)}
      </div>
      <div>{preview.summary}</div>
    </div>
  );
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
  const commandPreview = parseCommandApprovalPreview(preview);
  if (commandPreview) {
    return commandPreview;
  }
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

function parseCommandApprovalPreview(
  preview: Record<string, unknown>,
): CommandApprovalPreviewData | null {
  if (
    preview.kind !== "command" ||
    typeof preview.command !== "string" ||
    !Array.isArray(preview.args) ||
    !preview.args.every((arg) => typeof arg === "string") ||
    typeof preview.cwd !== "string" ||
    preview.filesystem !== "read-only" ||
    preview.network !== "disabled" ||
    typeof preview.summary !== "string" ||
    typeof preview.timeoutMs !== "number"
  ) {
    return null;
  }
  return {
    args: preview.args,
    command: preview.command,
    cwd: preview.cwd,
    filesystem: preview.filesystem,
    kind: "command",
    network: preview.network,
    summary: preview.summary,
    timeoutMs: preview.timeoutMs,
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
    toolName === "execute_command" ||
    (preview && isCommandPreview(preview))
  ) {
    return "命令执行";
  }
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

function isCommandPreview(
  preview: ApprovalPreviewData,
): preview is CommandApprovalPreviewData {
  return "kind" in preview && preview.kind === "command";
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
