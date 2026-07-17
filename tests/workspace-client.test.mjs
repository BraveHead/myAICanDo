import { afterEach, describe, expect, test } from "bun:test";

const { createWorkspaceOnServer, WorkspaceClientError } = await import(
  "../src/lib/workspace-client.ts"
);

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("workspace client", () => {
  test("creates a workspace and returns the server workspace", async () => {
    globalThis.fetch = async (input, init) => {
      expect(input).toBe("/api/tenants/tenant_a/workspaces");
      expect(init).toMatchObject({
        method: "POST",
        body: JSON.stringify({ name: "开发项目" }),
      });

      return new Response(
        JSON.stringify({
          workspace: {
            name: "开发项目",
            status: "active",
            workspaceId: "ws_1",
          },
        }),
        { status: 201 },
      );
    };

    await expect(createWorkspaceOnServer("tenant_a", "开发项目")).resolves.toEqual(
      {
        name: "开发项目",
        status: "active",
        workspaceId: "ws_1",
      },
    );
  });

  test("preserves the server error code for duplicate names", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: {
            code: "workspace_name_conflict",
            message: "该工作区名称已存在。",
          },
        }),
        { status: 409 },
      );

    await expect(
      createWorkspaceOnServer("tenant_a", "开发项目"),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "workspace_name_conflict",
        message: "该工作区名称已存在。",
        status: 409,
      }),
    );
    expect(WorkspaceClientError).toBeDefined();
  });
});
