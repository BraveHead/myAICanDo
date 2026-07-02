import { runDemoAgent } from "@/lib/agent/definitions/demo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let input = "现在几点了？";

  try {
    const body = (await request.json()) as { input?: string };
    if (typeof body.input === "string" && body.input.trim()) {
      input = body.input;
    }
  } catch {
    // 允许空 body，使用默认输入。
  }

  try {
    const text = await runDemoAgent(input);
    return Response.json({ text });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 500 });
  }
}
