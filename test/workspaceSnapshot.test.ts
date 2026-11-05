import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareWorkspaceSnapshot, removeWorkspaceSnapshot } from "../src/sandbox/workspaceSnapshot.js";
import { testConfig } from "./helpers.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("workspace snapshot", () => {
  it("copies safe files, filters secret-like paths, and remains disposable", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mcp-snapshot-source-")));
    roots.push(root);
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "src", "index.ts"), "export const value = 1;\n", { mode: 0o444 });
    await fs.writeFile(path.join(root, ".env.local"), "SECRET=value\n");
    await fs.mkdir(path.join(root, ".secure-mcp"));
    await fs.writeFile(path.join(root, ".secure-mcp", "token"), "token\n");
    await fs.symlink("src/index.ts", path.join(root, "index-link.ts"));

    const snapshot = await prepareWorkspaceSnapshot(testConfig(root));
    roots.push(snapshot.root);

    await expect(fs.readFile(path.join(snapshot.workspacePath, "src", "index.ts"), "utf8"))
      .resolves.toBe("export const value = 1;\n");
    await expect(fs.lstat(path.join(snapshot.workspacePath, "index-link.ts")))
      .resolves.toMatchObject({});
    await expect(fs.stat(path.join(snapshot.workspacePath, ".env.local"))).rejects.toThrow();
    await expect(fs.stat(path.join(snapshot.workspacePath, ".secure-mcp"))).rejects.toThrow();

    await fs.writeFile(path.join(snapshot.workspacePath, "src", "index.ts"), "changed in snapshot\n");
    await expect(fs.readFile(path.join(root, "src", "index.ts"), "utf8"))
      .resolves.toBe("export const value = 1;\n");
    expect(snapshot.summary.sensitiveEntriesSkipped).toBe(2);

    await removeWorkspaceSnapshot(snapshot.workspacePath);
    await expect(fs.stat(snapshot.root)).rejects.toThrow();
  });

  it("refuses to remove paths outside the managed snapshot base", async () => {
    const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mcp-snapshot-outside-")));
    roots.push(outside);
    await expect(removeWorkspaceSnapshot(outside)).rejects.toThrow(/unmanaged/);
  });
});
