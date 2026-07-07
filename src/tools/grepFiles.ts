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

export type GrepMatch = {
  path: string;
  line: number;
  column: number;
  text: string;
  fileTruncated: boolean;
};

export async function grepFilesTool(
  config: RuntimeConfig,
  input: { pattern: string; path?: string; include?: string[]; exclude?: string[]; maxMatches?: number }
) {
  return auditToolCall(config, "grep_files", {
    path: input.path ?? ".",
    pattern: input.pattern,
    include: input.include,
    exclude: input.exclude,
    maxMatches: input.maxMatches
  }, async () => {
    if (!input.pattern) {
      throw new PolicyError("grep_files pattern cannot be empty");
    }
    const regexp = new RegExp(input.pattern);
    const searchRoot = await resolveWorkspacePath(config.workspace.root, input.path ?? ".");
    if (config.policy.denySecretsRead) {
      assertNotSecretLike(config.workspace.root, searchRoot);
    }
    const stat = await fs.stat(searchRoot);
    if (!stat.isDirectory() && !stat.isFile()) {
      throw new Error("grep_files path must be a file or directory");
    }

    const maxMatches = Math.min(input.maxMatches ?? 100, 1000);
    const include = normalizeGlobPatterns(input.include ?? (stat.isFile() ? [path.basename(searchRoot)] : ["**/*"]));
    const ignore = [...DEFAULT_EXCLUDES, ...normalizeGlobPatterns(input.exclude ?? [])];
    const files = stat.isFile()
      ? [path.basename(searchRoot)]
      : await fg(include, {
        cwd: searchRoot,
        dot: true,
        onlyFiles: true,
        unique: true,
        ignore
      });

    const matches: GrepMatch[] = [];
    for (const file of files) {
      if (matches.length >= maxMatches) break;
      const absolutePath = stat.isFile() ? searchRoot : path.join(searchRoot, file);
      const realPath = await resolveWorkspacePath(config.workspace.root, absolutePath);
      try {
        if (config.policy.denySecretsRead) {
          assertNotSecretLike(config.workspace.root, realPath);
        }
      } catch (error) {
        if (stat.isFile()) throw error;
        continue;
      }
      const fileStat = await fs.stat(realPath);
      if (!fileStat.isFile()) continue;
      const { content, truncated } = await readFilePrefix(realPath, config.workspace.maxReadBytes);
      if (content.includes("\0")) continue;
      const lines = content.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const lineText = lines[index] ?? "";
        const found = regexp.exec(lineText);
        if (!found) continue;
        matches.push({
          path: toWorkspaceRelative(config.workspace.root, realPath),
          line: index + 1,
          column: found.index + 1,
          text: lineText,
          fileTruncated: truncated
        });
        if (matches.length >= maxMatches) break;
      }
    }

    return {
      matches,
      truncated: matches.length >= maxMatches
    };
  }, (result) => ({
    stdoutBytes: Buffer.byteLength(JSON.stringify(result.matches))
  }));
}

function normalizeGlobPatterns(patterns: string[]): string[] {
  return patterns.map((pattern) => {
    if (path.isAbsolute(pattern) || pattern.startsWith("!")) {
      throw new PolicyError(`Unsafe glob pattern: ${pattern}`);
    }
    const normalized = pattern.replace(/\\/g, "/");
    if (normalized.split("/").includes("..")) {
      throw new PolicyError(`Unsafe glob pattern: ${pattern}`);
    }
    return normalized;
  });
}

async function readFilePrefix(filePath: string, maxBytes: number): Promise<{ content: string; truncated: boolean }> {
  const stat = await fs.stat(filePath);
  const bytesToRead = Math.min(stat.size, maxBytes);
  const buffer = Buffer.alloc(bytesToRead);
  const handle = await fs.open(filePath, "r");
  try {
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
    return {
      content: buffer.subarray(0, bytesRead).toString("utf8"),
      truncated: bytesRead < stat.size
    };
  } finally {
    await handle.close();
  }
}

function toWorkspaceRelative(workspaceRoot: string, absolutePath: string): string {
  return path.relative(workspaceRoot, absolutePath).replace(/\\/g, "/");
}
