import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

mock.module("server-only", () => ({}));

const { buildMemoryManifest } = await import(
  "../src/lib/agent/harness/memory/manifest.ts"
);

let root;
let previousRoot;

beforeEach(async () => {
  previousRoot = process.env.FILESYSTEM_SANDBOX_ROOT;
  root = await fs.mkdtemp(path.join(os.tmpdir(), "memory-manifest-"));
  process.env.FILESYSTEM_SANDBOX_ROOT = root;
  delete process.env.DATABASE_URL;
});

afterEach(async () => {
  if (previousRoot === undefined) delete process.env.FILESYSTEM_SANDBOX_ROOT;
  else process.env.FILESYSTEM_SANDBOX_ROOT = previousRoot;
  await fs.rm(root, { force: true, recursive: true });
});

describe("memory manifest", () => {
  test("separates user, project, and harness memory", async () => {
    const projectRoot = path.join(root, "tenant_a", "workspaces", "ws_a");
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.writeFile(projectRoot + "/AGENTS.md", "项目规则", "utf8");
    const offloadRoot = path.join(
      root,
      "tenant_a",
      "user_a",
      "thread_a",
      ".context",
      "offloads",
    );
    await fs.mkdir(offloadRoot, { recursive: true });
    await fs.writeFile(
      path.join(offloadRoot, "call-1.json"),
      JSON.stringify({ artifactPath: ".context/offloads/call-1.json" }),
      "utf8",
    );

    const manifest = await buildMemoryManifest({
      scope: {
        tenantHashId: "tenant_a",
        userHashId: "user_a",
        workspaceId: "ws_a",
      },
      threadId: "thread_a",
    });

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.user).toEqual([]);
    expect(manifest.project[0]).toMatchObject({
      content: "项目规则",
      path: "AGENTS.md",
      source: "project-file",
    });
    expect(manifest.harness).toMatchObject({
      offloadReferences: [".context/offloads/call-1.json"],
      threadId: "thread_a",
    });
  });
});
