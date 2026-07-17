import { describe, expect, test } from "bun:test";

describe("project memory loader contract", () => {
  test("uses workspace root AGENTS.md rather than repository root AGENTS.md", async () => {
    const source = await Bun.file(
      new URL("../src/lib/agent/harness/memory/project-memory-loader.ts", import.meta.url),
    ).text();

    expect(source).toContain('"workspaces"');
    expect(source).toContain('"AGENTS.md"');
    expect(source).not.toContain("process.cwd(), PROJECT_MEMORY_FILE");
    expect(source).toContain("isSymbolicLink");
    expect(source).toContain('new TextDecoder("utf-8", { fatal: true })');
  });
});
