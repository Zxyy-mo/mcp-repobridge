import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import type { RuntimeConfig } from "../config/config.js";
import { auditToolCall } from "../audit/auditLog.js";
import { PolicyError } from "../policy/errors.js";
import { assertNotSecretLike, resolveWorkspacePath } from "../policy/pathPolicy.js";

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
  input: { pattern: string; path?: string; maxResults?: number }
) {
  return auditToolCall(config, "find_files", {
    path: input.path ?? ".",
    pattern: input.pattern,
    maxResults: input.maxResults
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
    const paths = await fg(pattern, {
      cwd: searchRoot,
      dot: true,
      onlyFiles: false,
      unique: true,
      ignore: DEFAULT_EXCLUDES,
      suppressErrors: true
    });
    const results: FindFileResult[] = [];
    for (const match of paths) {
      if (results.length >= maxResults) break;
      const absolutePath = path.join(searchRoot, match);
      const realPath = await resolveWorkspacePath(config.workspace.root, absolutePath);
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
    }

    return {
      results,
      truncated: paths.length > results.length
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
