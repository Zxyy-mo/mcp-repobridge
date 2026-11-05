import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type { RuntimeConfig } from "../config/config.js";
import { auditToolCall } from "../audit/auditLog.js";
import { PolicyError } from "../policy/errors.js";
import { assertNotSecretLike, resolveWorkspacePath } from "../policy/pathPolicy.js";
import { decodeCursor, encodeCursor } from "../utils/cursor.js";

const DEFAULT_EXCLUDES = [
  "**/.git/**",
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.secure-mcp/**"
];

export type FindFileResult = {
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
};

export async function findFilesTool(
  config: RuntimeConfig,
  input: { pattern: string; path?: string; maxResults?: number; cursor?: string }
) {
  return auditToolCall(config, "find_files", {
    path: input.path ?? ".",
    pattern: input.pattern,
    maxResults: input.maxResults,
    continuing: Boolean(input.cursor)
  }, async () => {
    if (!input.pattern) {
      throw new PolicyError("find_files pattern cannot be empty");
    }
    const searchRoot = await resolveWorkspacePath(config.workspace.root, input.path ?? ".");
    if (config.policy.denySecretsRead) {
      assertNotSecretLike(config.workspace.root, searchRoot);
    }
    const stat = await fs.stat(searchRoot);
    if (!stat.isDirectory()) {
      throw new Error("find_files path must be a directory");
    }

    const pattern = normalizeGlobPattern(input.pattern);
    const maxResults = Math.min(input.maxResults ?? 100, 1000);
    const workspaceRelativeRoot = path.relative(config.workspace.root, searchRoot).replace(/\\/g, "/");
    const scope = { path: workspaceRelativeRoot, pattern };
    const position = decodeCursor<{ after: string }>(input.cursor, "find_files", scope);
    const paths = (await fg(pattern, {
      cwd: searchRoot,
      dot: true,
      onlyFiles: false,
      unique: true,
      ignore: DEFAULT_EXCLUDES,
      suppressErrors: true
    })).sort((left, right) => left.localeCompare(right));
    const results: FindFileResult[] = [];
    const resultPositions: string[] = [];
    for (const match of paths) {
      if (position && match.localeCompare(position.after) <= 0) continue;
      const absolutePath = path.join(searchRoot, match);
      let realPath: string;
      try {
        realPath = await resolveWorkspacePath(config.workspace.root, absolutePath);
      } catch {
        continue;
      }
      try {
        if (config.policy.denySecretsRead) {
          assertNotSecretLike(config.workspace.root, realPath);
        }
      } catch {
        continue;
      }
      const entryStat = await fs.lstat(absolutePath);
      results.push({
        path: path.relative(config.workspace.root, realPath).replace(/\\/g, "/"),
        type: entryStat.isFile() ? "file" : entryStat.isDirectory() ? "directory" : entryStat.isSymbolicLink() ? "symlink" : "other",
        size: entryStat.size
      });
      resultPositions.push(match);
      if (results.length > maxResults) break;
    }

    const hasMore = results.length > maxResults;
    if (hasMore) {
      results.pop();
      resultPositions.pop();
    }
    const lastPosition = resultPositions.at(-1);
    const nextCursor = hasMore && lastPosition
      ? encodeCursor("find_files", scope, { after: lastPosition })
      : undefined;

    return {
      results,
      truncated: hasMore,
      nextCursor,
      nextAction: nextCursor
        ? {
          tool: "find_files",
          arguments: { pattern: input.pattern, path: input.path, maxResults, cursor: nextCursor },
          reason: "Continue the same file query after the last returned path."
        }
        : undefined
    };
  }, (result) => ({
    stdoutBytes: Buffer.byteLength(JSON.stringify(result.results))
  }));
}

function normalizeGlobPattern(pattern: string): string {
  if (path.isAbsolute(pattern) || pattern.startsWith("!")) {
    throw new PolicyError(`Unsafe glob pattern: ${pattern}`);
  }
  const normalized = pattern.replace(/\\/g, "/");
  if (normalized.split("/").includes("..")) {
    throw new PolicyError(`Unsafe glob pattern: ${pattern}`);
  }
  return normalized;
}
