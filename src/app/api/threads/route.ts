import {
  listStoredThreads,
  upsertStoredThreads,
} from "@/lib/server/thread-store";
import type { StoredThread } from "@/lib/thread-types";

type ThreadsRequestBody = {
  threads?: StoredThread[];
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({
    threads: await listStoredThreads(),
  });
}

export async function PUT(request: Request) {
  let body: ThreadsRequestBody;

  try {
    body = (await request.json()) as ThreadsRequestBody;
  } catch {
    return Response.json(
      {
        error: {
          code: "invalid_json",
          message: "请求体必须是合法 JSON。",
        },
      },
      { status: 400 },
    );
  }

  const threads = Array.isArray(body.threads)
    ? body.threads.filter(isStoredThread)
    : [];
  await upsertStoredThreads(threads);

  return Response.json({ ok: true });
}

function isStoredThread(thread: unknown): thread is StoredThread {
  if (!thread || typeof thread !== "object") {
    return false;
  }

  const candidate = thread as Partial<StoredThread>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.updatedAt === "string" &&
    candidate.status === "regular"
  );
}
