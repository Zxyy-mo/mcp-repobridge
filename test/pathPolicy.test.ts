import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertNotSecretLike, resolveWorkspacePath } from "../src/policy/pathPolicy.js";

describe("path policy", () => {
  it("allows relative paths inside workspace", async () => {
    const root = await makeWorkspace();
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "src", "file.txt"), "ok");

    await expect(resolveWorkspacePath(root, "src/file.txt")).resolves.toBe(path.join(root, "src", "file.txt"));
  });

  it("allows normalized absolute paths inside workspace", async () => {
    const root = await makeWorkspace();
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "src", "file.txt"), "ok");

    const requested = path.join(root, "src", "..", "src", "file.txt");
    await expect(resolveWorkspacePath(root, requested)).resolves.toBe(path.join(root, "src", "file.txt"));
  });

  it("rejects ../ traversal", async () => {
    const root = await makeWorkspace();
    await expect(resolveWorkspacePath(root, "../outside.txt")).rejects.toThrow(/escapes workspace/);
  });

  it("rejects absolute path outside workspace", async () => {
    const root = await makeWorkspace();
    await expect(resolveWorkspacePath(root, os.tmpdir())).rejects.toThrow(/escapes workspace/);
  });

  it("rejects symlink escape", async () => {
    const root = await makeWorkspace();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "secure-mcp-outside-"));
    await fs.writeFile(path.join(outside, "secret.txt"), "secret");
    await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "linked-secret.txt"));

    await expect(resolveWorkspacePath(root, "linked-secret.txt")).rejects.toThrow(/Symlink escapes workspace/);
  });

  it("blocks secret-like paths", async () => {
    const root = await makeWorkspace();

    expect(() => assertNotSecretLike(root, path.join(root, ".env"))).toThrow(/Secret-like file/);
    expect(() => assertNotSecretLike(root, path.join(root, ".ssh", "id_rsa"))).toThrow(/Secret-like path/);
    expect(() => assertNotSecretLike(root, path.join(root, ".secure-mcp", "audit.log"))).toThrow(/Secret-like path/);
  });
});

async function makeWorkspace(): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "secure-mcp-path-")));
}
