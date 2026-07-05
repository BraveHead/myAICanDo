"use client";

import { ChatRuntimeProvider } from "@/components/assistant/chat-runtime-provider";
import { ChatWorkspace } from "@/components/assistant/chat-workspace";

export function AppShell({
  initialThreadId,
  tenantHashId,
}: {
  initialThreadId?: string;
  tenantHashId: string;
}) {
  return (
    <ChatRuntimeProvider tenantHashId={tenantHashId}>
      <ChatWorkspace
        initialThreadId={initialThreadId}
        tenantHashId={tenantHashId}
      />
    </ChatRuntimeProvider>
  );
}
