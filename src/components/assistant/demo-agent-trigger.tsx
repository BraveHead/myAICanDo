"use client";

import { useState } from "react";

/**
 * 最小 demo agent 的页面触发按钮。
 *
 * 走独立的 /api/demo 路由，不经过项目现有的聊天/agent 抽象，
 * 仅用于验证 demo agent 能被触发并返回结果。
 */
export function DemoAgentTrigger() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setLoading(true);
    setResult(null);
    setError(null);

    try {
      const response = await fetch("/api/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: "现在几点了？请顺带自我介绍一句。" }),
      });
      const data = (await response.json()) as { text?: string; error?: string };

      if (!response.ok || data.error) {
        setError(data.error || `请求失败：HTTP ${response.status}`);
      } else {
        setResult(data.text ?? "");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mt-6 flex w-full flex-col items-center gap-3">
      <button
        className="flex h-10 items-center gap-2 rounded-full border border-[#ececec] bg-white px-4 text-[14px] font-medium text-[#242424] shadow-[0_1px_4px_rgba(0,0,0,0.03)] transition-colors hover:bg-[#f7f7f7] disabled:cursor-not-allowed disabled:opacity-50"
        disabled={loading}
        onClick={run}
        type="button"
      >
        {loading ? "运行中…" : "运行 Demo Agent"}
      </button>

      {(result || error) && (
        <div
          className={`w-full max-w-[600px] rounded-2xl border px-4 py-3 text-[14px] leading-7 ${
            error
              ? "border-[#f0caca] bg-[#fdf3f3] text-[#a13a3a]"
              : "border-[#ececec] bg-[#fafafa] text-[#191919]"
          }`}
        >
          {error ?? result}
        </div>
      )}
    </div>
  );
}
