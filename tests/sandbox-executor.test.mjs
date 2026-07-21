import { afterEach, describe, expect, test } from "bun:test";

const { createSandboxExecutor } = await import(
  "../src/lib/agent/services/command-execution.ts"
);

const previousBackend = process.env.EXECUTION_SANDBOX_BACKEND;

afterEach(() => {
  if (previousBackend === undefined) {
    delete process.env.EXECUTION_SANDBOX_BACKEND;
  } else {
    process.env.EXECUTION_SANDBOX_BACKEND = previousBackend;
  }
});

describe("M9 SandboxExecutor", () => {
  test("sandbox backend unavailable never falls back to an unisolated process", async () => {
    process.env.EXECUTION_SANDBOX_BACKEND = "mock";
    const executor = createSandboxExecutor();
    const result = await executor.execute({
      allowedRoots: ["/tmp/thread/workspace", "/tmp/thread/notes"],
      args: [],
      command: "pwd",
      cwd: "workspace",
      outputLimitBytes: 128 * 1024,
      readOnly: true,
      timeoutMs: 30_000,
    });

    expect(result).toMatchObject({
      status: "sandbox_unavailable",
      stdout: "",
      stderr: "",
    });
  });
});
