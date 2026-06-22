"use client";

import { ChatRuntimeProvider } from "@/components/assistant/chat-runtime-provider";
import { ChatWorkspace } from "@/components/assistant/chat-workspace";

export function AppShell() {
  return (
    <ChatRuntimeProvider>
      <ChatWorkspace />
    </ChatRuntimeProvider>
  );
}
