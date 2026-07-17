"use client";

import { ChatRuntimeProvider } from "@/components/assistant/chat-runtime-provider";
import { ChatWorkspace } from "@/components/assistant/chat-workspace";

export function AppShell({
  initialThreadId,
  tenantHashId,
  workspaceId,
}: {
  initialThreadId?: string;
  tenantHashId: string;
  workspaceId: string;
}) {
  return (
    <ChatRuntimeProvider tenantHashId={tenantHashId} workspaceId={workspaceId}>
      <ChatWorkspace
        initialThreadId={initialThreadId}
        tenantHashId={tenantHashId}
        workspaceId={workspaceId}
      />
    </ChatRuntimeProvider>
  );
}
