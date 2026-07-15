import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  getThreadTodoState,
  resetInMemoryTodoStatesForTests,
  writeThreadTodoState,
} from "../src/lib/agent/harness/planning/todo-store.ts";

const scope = {
  tenantHashId: "tenant_1",
  userHashId: "user_1",
};

let previousDatabaseUrl;

beforeEach(() => {
  previousDatabaseUrl = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  resetInMemoryTodoStatesForTests();
});

afterEach(() => {
  if (previousDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = previousDatabaseUrl;
  }

  resetInMemoryTodoStatesForTests();
});

describe("planning todo store", () => {
  test("writes todos, increments revision, and preserves ids by content", async () => {
    const first = await writeThreadTodoState(scope, {
      agentId: "filesystem",
      threadId: "thread_1",
      todos: [
        {
          content: "分析文件",
          status: "pending",
        },
      ],
    });

    expect(first.ok).toBe(true);
    expect(first.state.revision).toBe(1);
    const todoId = first.state.todos[0].id;

    const second = await writeThreadTodoState(scope, {
      agentId: "filesystem",
      threadId: "thread_1",
      todos: [
        {
          content: "分析文件",
          status: "in_progress",
        },
        {
          content: "产出报告",
          status: "pending",
        },
      ],
    });

    expect(second.ok).toBe(true);
    expect(second.state.revision).toBe(2);
    expect(second.state.todos[0]).toEqual({
      content: "分析文件",
      id: todoId,
      status: "in_progress",
    });
  });

  test("rejects multiple in_progress todos without mutating stored state", async () => {
    const first = await writeThreadTodoState(scope, {
      agentId: "coordinator",
      threadId: "thread_1",
      todos: [
        {
          content: "读取上下文",
          status: "pending",
        },
      ],
    });

    expect(first.ok).toBe(true);

    const invalid = await writeThreadTodoState(scope, {
      agentId: "coordinator",
      threadId: "thread_1",
      todos: [
        {
          content: "读取上下文",
          status: "in_progress",
        },
        {
          content: "生成结论",
          status: "in_progress",
        },
      ],
    });

    expect(invalid.ok).toBe(false);
    expect(invalid.error.code).toBe("multiple_in_progress");

    const stored = await getThreadTodoState(scope, "thread_1");
    expect(stored?.revision).toBe(1);
    expect(stored?.todos).toEqual(first.state.todos);
  });

  test("isolates todo state by tenant, user, and thread", async () => {
    await writeThreadTodoState(scope, {
      agentId: "demo",
      threadId: "thread_1",
      todos: [
        {
          content: "当前线程任务",
          status: "completed",
        },
      ],
    });

    await expect(getThreadTodoState(scope, "thread_2")).resolves.toBeNull();
    await expect(
      getThreadTodoState(
        {
          tenantHashId: "tenant_2",
          userHashId: "user_1",
        },
        "thread_1",
      ),
    ).resolves.toBeNull();
  });
});
