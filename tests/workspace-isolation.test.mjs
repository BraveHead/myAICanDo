import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

mock.module("server-only", () => ({}));

const { loadWorkspaceProjectMemory } = await import(
  "../src/lib/agent/harness/memory/project-memory-loader.ts"
);

let root;
let previousRoot;

beforeEach(async () => {
  previousRoot = process.env.FILESYSTEM_SANDBOX_ROOT;
  root = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-memory-"));
  process.env.FILESYSTEM_SANDBOX_ROOT = root;
});

afterEach(async () => {
  if (previousRoot === undefined) {
    delete process.env.FILESYSTEM_SANDBOX_ROOT;
  } else {
    process.env.FILESYSTEM_SANDBOX_ROOT = previousRoot;
  }
  await fs.rm(root, { force: true, recursive: true });
});

describe("workspace project memory isolation", () => {
  test("reads only the selected tenant and workspace AGENTS.md", async () => {
    await writeProjectMemory("tenant_a", "ws_a", "A workspace rules");
    await writeProjectMemory("tenant_a", "ws_b", "B workspace rules");
    await writeProjectMemory("tenant_b", "ws_a", "Other tenant rules");
    await fs.writeFile(path.join(root, "AGENTS.md"), "repository rules", "utf8");

    await expect(
      loadWorkspaceProjectMemory({ tenantHashId: "tenant_a", workspaceId: "ws_a" }),
    ).resolves.toMatchObject({ content: "A workspace rules", path: path.join(root, "tenant_a", "workspaces", "ws_a", "AGENTS.md") });
    await expect(
      loadWorkspaceProjectMemory({ tenantHashId: "tenant_a", workspaceId: "ws_b" }),
    ).resolves.toMatchObject({ content: "B workspace rules" });
    await expect(
      loadWorkspaceProjectMemory({ tenantHashId: "tenant_b", workspaceId: "ws_a" }),
    ).resolves.toMatchObject({ content: "Other tenant rules" });
  });

  test("ignores missing, oversized, and symlinked project memory", async () => {
    await expect(
      loadWorkspaceProjectMemory({ tenantHashId: "tenant_a", workspaceId: "missing" }),
    ).resolves.toBeNull();

    await writeProjectMemory("tenant_a", "oversized", "x".repeat(64 * 1024 + 1));
    await expect(
      loadWorkspaceProjectMemory({ tenantHashId: "tenant_a", workspaceId: "oversized" }),
    ).resolves.toBeNull();

    const target = path.join(root, "outside.md");
    await fs.writeFile(target, "outside", "utf8");
    await fs.mkdir(path.join(root, "tenant_a", "workspaces", "linked"), { recursive: true });
    await fs.symlink(target, path.join(root, "tenant_a", "workspaces", "linked", "AGENTS.md"));
    await expect(
      loadWorkspaceProjectMemory({ tenantHashId: "tenant_a", workspaceId: "linked" }),
    ).resolves.toBeNull();
  });
});

async function writeProjectMemory(tenantHashId, workspaceId, content) {
  const workspaceRoot = path.join(root, tenantHashId, "workspaces", workspaceId);
  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "AGENTS.md"), content, "utf8");
}
