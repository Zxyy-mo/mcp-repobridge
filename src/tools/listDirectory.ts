import fs from "node:fs/promises";
import path from "node:path";
import type { RuntimeConfig } from "../config/config.js";
import { auditToolCall } from "../audit/auditLog.js";
import { assertNotSecretLike, resolveWorkspacePath } from "../policy/pathPolicy.js";

export async function listDirectoryTool(config: RuntimeConfig, input: { path: string; limit?: number }) {
  return auditToolCall(config, "list_directory", {
    path: input.path,
    limit: input.limit ?? config.workspace.maxDirectoryEntries
  }, async () => {
    const target = await resolveWorkspacePath(config.workspace.root, input.path);
    if (config.policy.denySecretsRead) {
      assertNotSecretLike(config.workspace.root, target);
    }
    const stat = await fs.stat(target);
    if (!stat.isDirectory()) {
      throw new Error("list_directory target must be a directory");
    }
    const limit = Math.min(input.limit ?? config.workspace.maxDirectoryEntries, config.workspace.maxDirectoryEntries);
    const entries = await fs.readdir(target, { withFileTypes: true });
    const visibleEntries = [];
    for (const entry of entries) {
      const entryPath = path.join(target, entry.name);
      if (config.policy.denySecretsRead) {
        try {
          assertNotSecretLike(config.workspace.root, entryPath);
        } catch {
          continue;
        }
      }
      visibleEntries.push(entry);
      if (visibleEntries.length >= limit) break;
    }
    const limited = await Promise.all(visibleEntries.map(async (entry) => {
      const entryPath = path.join(target, entry.name);
      const entryStat = await fs.lstat(entryPath);
      return {
        name: entry.name,
        type: entry.isFile() ? "file" as const : entry.isDirectory() ? "directory" as const : entry.isSymbolicLink() ? "symlink" as const : "other" as const,
        size: entryStat.size
      };
    }));
    return {
      path: input.path,
      entries: limited,
      truncated: visibleEntries.length >= limit && entries.length > visibleEntries.length,
      workspaceRelative: path.relative(config.workspace.root, target)
    };
  }, (result) => ({
    stdoutBytes: Buffer.byteLength(JSON.stringify(result.entries))
  }));
}
