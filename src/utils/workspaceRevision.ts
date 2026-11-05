import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import { spawnLimited } from "./childProcess.js";

export async function sha256File(
  filePath: string,
  maxBytes = Number.MAX_SAFE_INTEGER
): Promise<{ sha256: string; size: number; mtimeMs: number }> {
  const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`Expected a regular file: ${filePath}`);
    if (stat.size > maxBytes) throw new Error(`File exceeds the ${maxBytes} byte hash limit: ${filePath}`);
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < stat.size) {
      const requested = Math.min(buffer.length, stat.size - position);
      const { bytesRead } = await handle.read(buffer, 0, requested, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return { sha256: hash.digest("hex"), size: stat.size, mtimeMs: stat.mtimeMs };
  } finally {
    await handle.close();
  }
}

export type GitWorkspaceState = {
  head?: string;
  changes: string[];
  diffStat?: string;
};

export async function captureGitWorkspaceState(root: string): Promise<GitWorkspaceState | undefined> {
  const [head, status, unstagedStat, stagedStat] = await Promise.all([
    runGit(root, ["rev-parse", "HEAD"]),
    runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    runGit(root, ["diff", "--stat", "--", "."]),
    runGit(root, ["diff", "--cached", "--stat", "--", "."])
  ]);
  if (!head.ok && !status.ok) return undefined;
  const diffStat = [unstagedStat.stdout.trim(), stagedStat.stdout.trim()].filter(Boolean).join("\n");
  return {
    head: /^[a-f0-9]{40}$/i.test(head.stdout.trim()) ? head.stdout.trim() : undefined,
    changes: parseStatusPaths(status.stdout),
    diffStat: diffStat || undefined
  };
}

function parseStatusPaths(value: string): string[] {
  const records = value.split("\0").filter(Boolean);
  const paths = new Set<string>();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 4) continue;
    const status = record.slice(0, 2);
    paths.add(record.slice(3).replace(/\\/g, "/"));
    if (/[RC]/.test(status) && records[index + 1]) index += 1;
  }
  return [...paths].sort();
}

async function runGit(root: string, args: string[]) {
  try {
    const result = await spawnLimited("git", ["-C", root, ...args], {
      timeoutMs: 10000,
      maxOutputBytes: 200000,
      env: { PATH: process.env.PATH ?? "", LANG: "C", LC_ALL: "C" }
    });
    return { ok: result.code === 0, stdout: result.stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}
