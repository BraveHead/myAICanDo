"use client";

import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import {
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import {
  BarChart3,
  BookOpen,
  Bot,
  Code2,
  Compass,
  Lightbulb,
  Mic,
  PanelLeft,
  PenLine,
  Plus,
  Send,
  Share,
  Sparkles,
  SunMedium,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createThread,
  getThreadTitle,
  loadActiveThreadId,
  loadRepository,
  loadThreads,
  saveActiveThreadId,
  saveRepository,
  saveThreads,
  type StoredThread,
} from "@/lib/thread-storage";
import type { SupportedAgent } from "@/lib/agent/agent-ids";

const tabs = [
  "Base",
  "ChatGPT",
  "Claude",
  "Grok",
  "Gemini",
  "Perplexity",
  "Explore More ->",
];

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

export function ChatWorkspace() {
  return (
    <main className="flex min-h-screen flex-col bg-white text-[#121212]">
      <TopNav />
      <section className="flex min-h-0 flex-1 p-3 sm:p-4">
        <div className="flex min-h-[calc(100vh-96px)] w-full overflow-hidden rounded-[22px] border border-[#e6e6e6] bg-white shadow-[0_1px_10px_rgba(0,0,0,0.04)]">
          <ChatWorkspaceContent />
        </div>
      </section>
    </main>
  );
}

function TopNav() {
  return (
    <header className="flex h-[58px] shrink-0 items-center justify-between border-b border-[#eeeeee] px-4 sm:px-7">
      <nav className="flex min-w-0 items-center gap-3 overflow-x-auto">
        {tabs.map((tab, index) => (
          <button
            key={tab}
            className={`h-9 shrink-0 rounded-lg px-3 text-[15px] font-medium transition-colors ${
              index === 0
                ? "bg-[#f0f0f0] text-[#111111] shadow-[inset_0_-2px_0_#111111]"
                : "text-[#242424] hover:bg-[#f6f6f6]"
            }`}
            type="button"
          >
            {tab}
          </button>
        ))}
      </nav>

      <div className="ml-4 flex shrink-0 items-center gap-3 text-[#777777]">
        <button
          className="grid size-8 place-items-center rounded-md hover:bg-[#f4f4f4]"
          title="Open"
          type="button"
        >
          <Compass size={17} />
        </button>
        <button
          className="grid size-8 place-items-center rounded-md hover:bg-[#f4f4f4]"
          title="Close"
          type="button"
        >
          <X size={17} />
        </button>
      </div>
    </header>
  );
}

function ChatWorkspaceContent() {
  const aui = useAui();
  const [threads, setThreads] = useState<StoredThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const switchingRef = useRef(false);

  useEffect(() => {
    queueMicrotask(() => {
      const storedThreads = loadThreads();
      const initialThreads =
        storedThreads.length > 0 ? storedThreads : [createThread()];
      const storedActiveThreadId = loadActiveThreadId();
      const initialActiveThreadId =
        storedActiveThreadId &&
        initialThreads.some((thread) => thread.id === storedActiveThreadId)
          ? storedActiveThreadId
          : initialThreads[0]?.id;

      setThreads(initialThreads);
      setActiveThreadId(initialActiveThreadId ?? null);
      saveThreads(initialThreads);

      if (initialActiveThreadId) {
        saveActiveThreadId(initialActiveThreadId);
      }

      setHydrated(true);
    });
  }, []);

  useEffect(() => {
    if (!hydrated || !activeThreadId) {
      return;
    }

    switchingRef.current = true;
    const repository = loadRepository(activeThreadId);
    const thread = aui.thread();

    if (repository) {
      thread.import(repository);
    } else {
      thread.reset();
    }

    queueMicrotask(() => {
      switchingRef.current = false;
    });
  }, [activeThreadId, hydrated, aui]);

  useEffect(() => {
    if (!hydrated || !activeThreadId) {
      return;
    }

    return aui.subscribe(() => {
      if (switchingRef.current) {
        return;
      }

      const thread = aui.thread();
      const repository = thread.export();
      const state = thread.getState();
      saveRepository(activeThreadId, repository);

      const nextTitle = getThreadTitle(state.messages);
      setThreads((currentThreads) => {
        const nextThreads = currentThreads.map((thread) =>
          thread.id === activeThreadId
            ? {
                ...thread,
                title: nextTitle,
                updatedAt: new Date().toISOString(),
              }
            : thread,
        );
        saveThreads(nextThreads);
        return nextThreads;
      });
    });
  }, [activeThreadId, hydrated, aui]);

  const activeThread = useMemo(
    () => threads.find((thread) => thread.id === activeThreadId),
    [activeThreadId, threads],
  );

  const persistCurrentThread = useCallback(() => {
    if (!activeThreadId) {
      return;
    }

    saveRepository(activeThreadId, aui.thread().export());
  }, [activeThreadId, aui]);

  const handleNewThread = useCallback(() => {
    persistCurrentThread();

    const nextThread = createThread();
    setThreads((currentThreads) => {
      const nextThreads = [nextThread, ...currentThreads];
      saveThreads(nextThreads);
      return nextThreads;
    });
    setActiveThreadId(nextThread.id);
    saveActiveThreadId(nextThread.id);
  }, [persistCurrentThread]);

  const handleSelectThread = useCallback(
    (threadId: string) => {
      if (threadId === activeThreadId) {
        return;
      }

      persistCurrentThread();
      setActiveThreadId(threadId);
      saveActiveThreadId(threadId);
    },
    [activeThreadId, persistCurrentThread],
  );

  return (
    <>
      <aside className="hidden w-[252px] shrink-0 flex-col border-r border-[#f0f0f0] bg-[#fcfcfc] p-4 md:flex">
        <div className="mb-8 flex items-center gap-3 px-2 pt-3">
          <Bot size={24} strokeWidth={2.4} />
          <span className="text-[15px] font-semibold">assistant-ui</span>
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
          <button
            className="grid size-8 place-items-center rounded-md text-[#7b7b7b] hover:bg-[#f5f5f5]"
            title="Share"
            type="button"
          >
            <Share size={18} />
          </button>
        </div>

        <Thread />
      </section>
    </>
  );
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

function AssistantLoading() {
  return (
    <div className="flex items-center gap-2 py-1 text-sm text-[#777777]">
      <span className="size-2 animate-pulse rounded-full bg-[#999999]" />
      Thinking
    </div>
  );
}
