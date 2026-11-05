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

export type GrepMatch = {
  path: string;
  line: number;
  column: number;
  text: string;
  fileTruncated: boolean;
};

export async function grepFilesTool(
  config: RuntimeConfig,
  input: { pattern: string; path?: string; include?: string[]; exclude?: string[]; maxMatches?: number; cursor?: string }
) {
  return auditToolCall(config, "grep_files", {
    path: input.path ?? ".",
    pattern: input.pattern,
    include: input.include,
    exclude: input.exclude,
    maxMatches: input.maxMatches,
    continuing: Boolean(input.cursor)
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
    const files = (stat.isFile()
      ? [path.basename(searchRoot)]
      : await fg(include, {
        cwd: searchRoot,
        dot: true,
        onlyFiles: true,
        unique: true,
        ignore
      })).sort((left, right) => left.localeCompare(right));

    const workspaceRelativeRoot = path.relative(config.workspace.root, searchRoot).replace(/\\/g, "/");
    const scope = {
      path: workspaceRelativeRoot,
      pattern: input.pattern,
      include: [...include].sort(),
      exclude: [...ignore].sort()
    };
    const position = decodeCursor<{ file: string; line: number }>(input.cursor, "grep_files", scope);

    const matches: GrepMatch[] = [];
    const positions: Array<{ file: string; line: number }> = [];
    let hasMore = false;
    outer:
    for (const file of files) {
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
        const line = index + 1;
        if (position && (file.localeCompare(position.file) < 0 || (file === position.file && line <= position.line))) {
          continue;
        }
        const lineText = lines[index] ?? "";
        regexp.lastIndex = 0;
        const found = regexp.exec(lineText);
        if (!found) continue;
        if (matches.length >= maxMatches) {
          hasMore = true;
          break outer;
        }
        matches.push({
          path: toWorkspaceRelative(config.workspace.root, realPath),
          line,
          column: found.index + 1,
          text: lineText,
          fileTruncated: truncated
        });
        positions.push({ file, line });
      }
    }

    const lastPosition = positions.at(-1);
    const nextCursor = hasMore && lastPosition
      ? encodeCursor("grep_files", scope, lastPosition)
      : undefined;

    return {
      matches,
      truncated: hasMore,
      nextCursor,
      nextAction: nextCursor
        ? {
          tool: "grep_files",
          arguments: {
            pattern: input.pattern,
            path: input.path,
            include: input.include,
            exclude: input.exclude,
            maxMatches,
            cursor: nextCursor
          },
          reason: "Continue the same search after the last returned match."
        }
        : undefined
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
