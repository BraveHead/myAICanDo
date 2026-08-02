import { describe, expect, test } from "bun:test";
import {
  McpAccessError,
  requireMcpThreadAccess,
} from "../src/lib/mcp/access/policy.ts";
import {
  createPostgresMcpAccessRepository,
} from "../src/lib/mcp/access/repository.ts";
import {
  loadMcpServerConfig,
  MCP_SERVER_NAME,
  McpConfigError,
} from "../src/lib/mcp/config.ts";

const validEnvironment = {
  DATABASE_URL: "postgresql://localhost/my_ai_can_do",
  MCP_TENANT_HASH_ID: "tenant_1",
  MCP_USER_HASH_ID: "user_1",
};

const validAccessInput = {
  tenantHashId: "tenant_1",
  threadId: "thread_1",
  userHashId: "user_1",
  workspaceId: "workspace_1",
};

describe("M11 MCP 配置", () => {
  test("要求三个必填环境变量均为非空字符串", () => {
    for (const name of [
      "DATABASE_URL",
      "MCP_TENANT_HASH_ID",
      "MCP_USER_HASH_ID",
    ]) {
      expect(() =>
        loadMcpServerConfig({
          ...validEnvironment,
          [name]: " \t ",
        }),
      ).toThrow(McpConfigError);
      expect(() =>
        loadMcpServerConfig({
          ...validEnvironment,
          [name]: undefined,
        }),
      ).toThrow(`缺少必填环境变量 ${name}。`);
    }
  });

  test("裁剪环境变量空白并使用固定服务名", () => {
    const config = loadMcpServerConfig({
      DATABASE_URL: "  postgresql://localhost/my_ai_can_do  ",
      MCP_TENANT_HASH_ID: " tenant_1 ",
      MCP_USER_HASH_ID: "\tuser_1\n",
    });

    expect(config).toMatchObject({
      databaseUrl: "postgresql://localhost/my_ai_can_do",
      identity: {
        tenantHashId: "tenant_1",
        userHashId: "user_1",
      },
      metadata: {
        name: MCP_SERVER_NAME,
      },
    });
    expect(config.metadata.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("M11 MCP Access Repository", () => {
  test("PostgreSQL 行只在 Repository 边界映射为访问领域对象", async () => {
    const calls = [];
    const repository = createPostgresMcpAccessRepository(() => ({
      async query(sql, values) {
        calls.push({ sql, values });
        if (sql.includes("saas_users")) {
          return {
            rows: [
              {
                is_active: true,
                joined_tenant_hash_ids: ["tenant_1"],
              },
            ],
          };
        }
        if (sql.includes("saas_tenants")) {
          return { rows: [{ status: "active" }] };
        }
        if (sql.includes("assistant_workspaces")) {
          return {
            rows: [{ status: "active", tenant_hash_id: "tenant_1" }],
          };
        }
        return { rows: [{ workspace_id: "workspace_1" }] };
      },
    }));

    await expect(repository.findUserByHashId("user_1")).resolves.toEqual({
      isActive: true,
      joinedTenantHashIds: ["tenant_1"],
    });
    await expect(
      repository.findTenantByHashId("tenant_1"),
    ).resolves.toEqual({ status: "active" });
    await expect(
      repository.findWorkspaceById("workspace_1"),
    ).resolves.toEqual({
      status: "active",
      tenantHashId: "tenant_1",
    });
    await expect(
      repository.findThreadByScope({
        tenantHashId: "tenant_1",
        threadId: "thread_1",
        userHashId: "user_1",
      }),
    ).resolves.toEqual({ workspaceId: "workspace_1" });

    expect(calls.map((call) => call.values)).toEqual([
      ["user_1"],
      ["tenant_1"],
      ["workspace_1"],
      ["tenant_1", "user_1", "thread_1"],
    ]);
  });
});

describe("M11 MCP 线程作用域访问策略", () => {
  test("有效作用域会被规范化并转换为可信 scope", async () => {
    const calls = [];
    const dependencies = createAccessDependencies({
      async findThreadByScope(input) {
        calls.push(["thread", input]);
        return { workspaceId: "workspace_1" };
      },
      async findUserByHashId(userHashId) {
        calls.push(["user", userHashId]);
        return {
          isActive: true,
          joinedTenantHashIds: ["tenant_1"],
        };
      },
    });

    await expect(
      requireMcpThreadAccess(
        {
          tenantHashId: " tenant_1 ",
          threadId: " thread_1 ",
          userHashId: " user_1 ",
          workspaceId: " workspace_1 ",
        },
        dependencies,
      ),
    ).resolves.toEqual({
      scope: {
        tenantHashId: "tenant_1",
        userHashId: "user_1",
        workspaceId: "workspace_1",
      },
      threadId: "thread_1",
    });
    expect(calls).toContainEqual(["user", "user_1"]);
    expect(calls).toContainEqual([
      "thread",
      {
        tenantHashId: "tenant_1",
        threadId: "thread_1",
        userHashId: "user_1",
      },
    ]);
  });

  test("拒绝已停用用户", async () => {
    await expectAccessError(
      createAccessDependencies({
        async findUserByHashId() {
          return {
            isActive: false,
            joinedTenantHashIds: ["tenant_1"],
          };
        },
      }),
      "user_inactive",
      403,
    );
  });

  test("拒绝未加入当前租户的用户", async () => {
    await expectAccessError(
      createAccessDependencies({
        async findUserByHashId() {
          return {
            isActive: true,
            joinedTenantHashIds: ["tenant_other"],
          };
        },
      }),
      "tenant_forbidden",
      403,
    );
  });

  test("拒绝已过期租户", async () => {
    await expectAccessError(
      createAccessDependencies({
        async findTenantByHashId() {
          return { status: "expired" };
        },
      }),
      "tenant_expired",
      403,
    );
  });

  test("跨租户工作区对外表现为工作区不存在", async () => {
    await expectAccessError(
      createAccessDependencies({
        async findWorkspaceById() {
          return {
            status: "active",
            tenantHashId: "tenant_other",
          };
        },
      }),
      "workspace_not_found",
      404,
    );
  });

  test("拒绝不存在或未绑定工作区的线程", async () => {
    for (const thread of [null, { workspaceId: null }]) {
      await expectAccessError(
        createAccessDependencies({
          async findThreadByScope() {
            return thread;
          },
        }),
        "thread_not_found",
        404,
      );
    }
  });

  test("拒绝绑定到其他工作区的线程", async () => {
    await expectAccessError(
      createAccessDependencies({
        async findThreadByScope() {
          return { workspaceId: "workspace_other" };
        },
      }),
      "thread_workspace_mismatch",
      403,
    );
  });
});

function createAccessDependencies(overrides = {}) {
  return {
    async findTenantByHashId() {
      return { status: "active" };
    },
    async findThreadByScope() {
      return { workspaceId: "workspace_1" };
    },
    async findUserByHashId() {
      return {
        isActive: true,
        joinedTenantHashIds: ["tenant_1"],
      };
    },
    async findWorkspaceById() {
      return {
        status: "active",
        tenantHashId: "tenant_1",
      };
    },
    ...overrides,
  };
}

async function expectAccessError(dependencies, code, status) {
  try {
    await requireMcpThreadAccess(validAccessInput, dependencies);
    throw new Error(`预期访问策略抛出 ${code}。`);
  } catch (error) {
    expect(error).toBeInstanceOf(McpAccessError);
    expect(error).toMatchObject({ code, status });
  }
}
