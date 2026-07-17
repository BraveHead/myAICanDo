"use client";

import { ArrowLeft, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import {
  createWorkspaceOnServer,
  WorkspaceClientError,
} from "@/lib/workspace-client";
import {
  getTenantPath,
  getWorkspacePath,
} from "@/lib/thread-routes";

const MAX_WORKSPACE_NAME_LENGTH = 80;

export function CreateWorkspaceForm({
  tenantHashId,
}: {
  tenantHashId: string;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedName = normalizeWorkspaceName(name);

    if (!normalizedName) {
      setError("请输入工作区名称，且名称不能超过 80 个字符。");
      return;
    }

    setPending(true);
    setError(null);

    try {
      const workspace = await createWorkspaceOnServer(
        tenantHashId,
        normalizedName,
      );
      router.replace(getWorkspacePath(tenantHashId, workspace.workspaceId));
    } catch (submitError) {
      setError(
        submitError instanceof WorkspaceClientError ||
          submitError instanceof Error
          ? submitError.message
          : "工作区创建失败，请稍后重试。",
      );
      setPending(false);
    }
  }

  return (
    <form className="space-y-5" onSubmit={handleSubmit}>
      {error && (
        <div
          aria-live="polite"
          className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm leading-6 text-red-700"
          role="alert"
        >
          {error}
        </div>
      )}

      <div>
        <label
          className="mb-2 block text-sm font-medium text-[#222222]"
          htmlFor="workspace-name"
        >
          工作区名称
        </label>
        <input
          aria-describedby="workspace-name-hint"
          aria-invalid={error ? "true" : undefined}
          aria-required="true"
          autoComplete="off"
          className="h-11 w-full rounded-lg border border-[#dcdcd7] bg-white px-3 text-sm text-[#202020] outline-none transition-colors placeholder:text-[#999999] focus:border-[#888882]"
          disabled={pending}
          id="workspace-name"
          maxLength={MAX_WORKSPACE_NAME_LENGTH}
          onChange={(event) => setName(event.target.value)}
          placeholder="例如：myAICanDo 开发项目"
          value={name}
        />
        <p
          className="mt-2 text-xs leading-5 text-[#777777]"
          id="workspace-name-hint"
        >
          最多 80 个字符，同一租户下名称不能重复。
        </p>
      </div>

      <div className="flex items-center justify-between gap-3">
        <Link
          className="flex h-10 items-center gap-2 rounded-lg px-3 text-sm font-medium text-[#555555] transition-colors hover:bg-[#f5f5f3]"
          href={getTenantPath(tenantHashId)}
        >
          <ArrowLeft size={16} />
          返回对话
        </Link>
        <button
          className="flex h-10 items-center gap-2 rounded-lg bg-[#111111] px-4 text-sm font-medium text-white transition-colors hover:bg-[#333333] disabled:cursor-not-allowed disabled:bg-[#aaaaaa]"
          disabled={pending}
          type="submit"
        >
          <Plus size={16} />
          {pending ? "创建中…" : "创建工作区"}
        </button>
      </div>
    </form>
  );
}

function normalizeWorkspaceName(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= MAX_WORKSPACE_NAME_LENGTH ? normalized : "";
}
