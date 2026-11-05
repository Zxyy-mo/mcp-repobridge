import fs from "node:fs/promises";
import path from "node:path";
import type { RuntimeConfig } from "../config/config.js";
import { auditToolCall } from "../audit/auditLog.js";
import { assertNotSecretLike, resolveWorkspacePath } from "../policy/pathPolicy.js";
import { decodeCursor, encodeCursor } from "../utils/cursor.js";

export async function listDirectoryTool(config: RuntimeConfig, input: { path: string; limit?: number; cursor?: string }) {
  return auditToolCall(config, "list_directory", {
    path: input.path,
    limit: input.limit ?? config.workspace.maxDirectoryEntries,
    continuing: Boolean(input.cursor)
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
    const workspaceRelative = path.relative(config.workspace.root, target).replace(/\\/g, "/");
    const scope = { path: workspaceRelative };
    const position = decodeCursor<{ after: string }>(input.cursor, "list_directory", scope);
    const entries = (await fs.readdir(target, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    const visibleEntries = [];
    for (const entry of entries) {
      if (position && entry.name.localeCompare(position.after) <= 0) continue;
      const entryPath = path.join(target, entry.name);
      if (config.policy.denySecretsRead) {
        try {
          assertNotSecretLike(config.workspace.root, entryPath);
        } catch {
          continue;
        }
      }
      visibleEntries.push(entry);
      if (visibleEntries.length > limit) break;
    }
    const hasMore = visibleEntries.length > limit;
    const pageEntries = visibleEntries.slice(0, limit);
    const limited = await Promise.all(pageEntries.map(async (entry) => {
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
      truncated: hasMore,
      nextCursor: hasMore && pageEntries.length > 0
        ? encodeCursor("list_directory", scope, { after: pageEntries.at(-1)?.name })
        : undefined,
      workspaceRelative,
      nextAction: hasMore && pageEntries.length > 0
        ? {
          tool: "list_directory",
          arguments: {
            path: input.path,
            limit,
            cursor: encodeCursor("list_directory", scope, { after: pageEntries.at(-1)?.name })
          },
          reason: "Continue listing the same directory after the last returned entry."
        }
        : undefined
    };
  }, (result) => ({
    stdoutBytes: Buffer.byteLength(JSON.stringify(result.entries))
  }));
}
