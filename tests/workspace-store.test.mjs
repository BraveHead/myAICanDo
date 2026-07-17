import { afterEach, describe, expect, test } from "bun:test";

const {
  createWorkspace,
  ensureDefaultWorkspace,
  getWorkspace,
  listWorkspaces,
  resetInMemoryWorkspacesForTests,
} = await import("../src/lib/server/workspace-store.ts");

afterEach(() => {
  delete process.env.DATABASE_URL;
  resetInMemoryWorkspacesForTests();
});

describe("workspace store", () => {
  test("creates an opaque default workspace and lists it per tenant", async () => {
    delete process.env.DATABASE_URL;
    const workspace = await ensureDefaultWorkspace("tenant_a", "user_a");

    expect(workspace.name).toBe("默认工作区");
    expect(workspace.workspaceId).toMatch(/^ws_/);
    expect(await listWorkspaces("tenant_a")).toHaveLength(1);
    expect(await listWorkspaces("tenant_b")).toHaveLength(1);
    expect(await getWorkspace("tenant_b", workspace.workspaceId)).toBeUndefined();
  });

  test("creates an active workspace with a bounded name", async () => {
    const result = await createWorkspace("tenant_a", "user_a", "开发项目");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.workspace.name).toBe("开发项目");
      expect(result.workspace.status).toBe("active");
      expect(await getWorkspace("tenant_a", result.workspace.workspaceId)).toEqual(
        result.workspace,
      );
    }
  });

  test("rejects invalid and duplicate workspace names per tenant", async () => {
    expect(
      await createWorkspace("tenant_a", "user_a", "   "),
    ).toMatchObject({
      error: { code: "workspace_name_invalid" },
      ok: false,
    });

    expect(await createWorkspace("tenant_a", "user_a", "开发项目")).toMatchObject({
      ok: true,
    });
    expect(
      await createWorkspace("tenant_a", "user_a", "  开发项目  "),
    ).toMatchObject({
      error: {
        code: "workspace_name_conflict",
      },
      ok: false,
    });
    expect(await createWorkspace("tenant_b", "user_a", "开发项目")).toMatchObject({
      ok: true,
    });
  });
});
