import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  deleteFilesystemFile,
  editFilesystemFile,
  globFilesystemFiles,
  writeFilesystemFile,
} from "../src/lib/agent/services/filesystem-service.ts";

const context = {
  threadId: "thread_1",
  threadScope: {
    tenantHashId: "tenant_1",
    userHashId: "user_1",
  },
};

let previousSandboxRoot;
let sandboxRoot;

beforeEach(async () => {
  previousSandboxRoot = process.env.FILESYSTEM_SANDBOX_ROOT;
  sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "filesystem-service-"));
  process.env.FILESYSTEM_SANDBOX_ROOT = sandboxRoot;
});

afterEach(async () => {
  if (previousSandboxRoot === undefined) {
    delete process.env.FILESYSTEM_SANDBOX_ROOT;
  } else {
    process.env.FILESYSTEM_SANDBOX_ROOT = previousSandboxRoot;
  }

  await fs.rm(sandboxRoot, {
    force: true,
    recursive: true,
  });
});

describe("filesystem-service", () => {
  test("globFilesystemFiles matches text files with a result limit", async () => {
    await fs.mkdir(sandboxPath("workspace", "nested"), { recursive: true });
    await fs.mkdir(sandboxPath("notes"), { recursive: true });
    await fs.writeFile(sandboxPath("workspace", "a.txt"), "a", "utf8");
    await fs.writeFile(sandboxPath("workspace", "nested", "b.txt"), "b", "utf8");
    await fs.writeFile(sandboxPath("workspace", "nested", "c.md"), "c", "utf8");
    await fs.writeFile(sandboxPath("notes", "d.txt"), "d", "utf8");

    const result = await globFilesystemFiles(context, {
      maxResults: 2,
      pattern: "**/*.txt",
    });

    expect(result.ok).toBe(true);
    expect(result.matches).toHaveLength(2);
    expect(result.matches.every((match) => match.path.endsWith(".txt"))).toBe(
      true,
    );
    expect(result.truncated).toBe(true);
  });

  test("writeFilesystemFile writes only allowed workspace and notes paths", async () => {
    const workspaceWrite = await writeFilesystemFile(context, {
      content: "hello",
      path: "workspace/a.txt",
    });
    const notesWrite = await writeFilesystemFile(context, {
      content: "note",
      path: "notes/a.txt",
    });

    expect(workspaceWrite.ok).toBe(true);
    expect(notesWrite.ok).toBe(true);
    await expect(fs.readFile(sandboxPath("workspace", "a.txt"), "utf8")).resolves.toBe(
      "hello",
    );
    await expect(fs.readFile(sandboxPath("notes", "a.txt"), "utf8")).resolves.toBe(
      "note",
    );

    const deniedPaths = [
      "other/a.txt",
      ".env",
      "workspace/.env",
      "../a.txt",
      path.join(sandboxRoot, "absolute.txt"),
    ];

    for (const deniedPath of deniedPaths) {
      const result = await writeFilesystemFile(context, {
        content: "blocked",
        path: deniedPath,
      });
      expect(result.ok).toBe(false);
    }
  });

  test("editFilesystemFile applies one exact replacement and rejects ambiguous matches", async () => {
    await fs.mkdir(sandboxPath("workspace"), { recursive: true });
    await fs.writeFile(sandboxPath("workspace", "a.txt"), "hello world", "utf8");
    await fs.writeFile(
      sandboxPath("workspace", "ambiguous.txt"),
      "same same",
      "utf8",
    );

    const edited = await editFilesystemFile(context, {
      newText: "hi",
      oldText: "hello",
      path: "workspace/a.txt",
    });
    const ambiguous = await editFilesystemFile(context, {
      newText: "x",
      oldText: "same",
      path: "workspace/ambiguous.txt",
    });

    expect(edited.ok).toBe(true);
    await expect(fs.readFile(sandboxPath("workspace", "a.txt"), "utf8")).resolves.toBe(
      "hi world",
    );
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.error.code).toBe("ambiguous_match");
  });

  test("deleteFilesystemFile deletes files and rejects directories and symlinks", async () => {
    await fs.mkdir(sandboxPath("workspace", "dir"), { recursive: true });
    await fs.writeFile(sandboxPath("workspace", "remove.txt"), "remove", "utf8");
    await fs.writeFile(sandboxPath("workspace", "target.txt"), "target", "utf8");
    await fs.symlink(
      sandboxPath("workspace", "target.txt"),
      sandboxPath("workspace", "link.txt"),
    );

    const deleted = await deleteFilesystemFile(context, {
      path: "workspace/remove.txt",
    });
    const directoryDelete = await deleteFilesystemFile(context, {
      path: "workspace/dir",
    });
    const symlinkDelete = await deleteFilesystemFile(context, {
      path: "workspace/link.txt",
    });

    expect(deleted.ok).toBe(true);
    await expect(fs.stat(sandboxPath("workspace", "remove.txt"))).rejects.toThrow();
    expect(directoryDelete.ok).toBe(false);
    expect(directoryDelete.error.code).toBe("not_file");
    expect(symlinkDelete.ok).toBe(false);
    expect(symlinkDelete.error.code).toBe("symlink_not_allowed");
  });
});

function sandboxPath(...segments) {
  return path.join(
    sandboxRoot,
    context.threadScope.tenantHashId,
    context.threadScope.userHashId,
    context.threadId,
    ...segments,
  );
}
