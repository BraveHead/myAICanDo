import {
  createStoredThread,
  listStoredThreads,
} from "@/lib/server/thread-store";

type ThreadsRequestBody = {
  title?: string;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({
    threads: await listStoredThreads(),
  });
}

export async function POST(request: Request) {
  let body: ThreadsRequestBody = {};

  try {
    body = (await request.json()) as ThreadsRequestBody;
  } catch {
    body = {};
  }

  return Response.json({
    thread: await createStoredThread(normalizeTitle(body.title)),
  });
}

function normalizeTitle(title: unknown) {
  if (typeof title !== "string") {
    return "New Chat";
  }

  const normalizedTitle = title.replace(/\s+/g, " ").trim();
  return normalizedTitle || "New Chat";
}
