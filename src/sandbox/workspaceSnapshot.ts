import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { constants } from "node:fs";
import type { RuntimeConfig } from "../config/config.js";
import { isSecretLikeRelativePath } from "../policy/pathPolicy.js";

const SNAPSHOT_BASE_NAME = "mcp-repobridge-sandboxes";
const COPY_BUFFER_BYTES = 64 * 1024;

export type WorkspaceSnapshotSummary = {
  filesCopied: number;
  directoriesCopied: number;
  symlinksCopied: number;
  bytesCopied: number;
  sensitiveEntriesSkipped: number;
  specialEntriesSkipped: number;
};

export type PreparedWorkspaceSnapshot = {
  root: string;
  workspacePath: string;
  summary: WorkspaceSnapshotSummary;
};

export async function prepareWorkspaceSnapshot(config: RuntimeConfig): Promise<PreparedWorkspaceSnapshot> {
  const workspaceRoot = await fs.realpath(config.workspace.root);
  const snapshotBase = await ensureSnapshotBase();
  if (isSubpath(workspaceRoot, snapshotBase)) {
    throw new Error("Sandbox snapshot base must be outside the configured workspace");
  }

  const snapshotRoot = await fs.mkdtemp(path.join(snapshotBase, "snapshot-"));
  const workspacePath = path.join(snapshotRoot, "workspace");
  const summary: WorkspaceSnapshotSummary = {
    filesCopied: 0,
    directoriesCopied: 1,
    symlinksCopied: 0,
    bytesCopied: 0,
    sensitiveEntriesSkipped: 0,
    specialEntriesSkipped: 0
  };

  try {
    // The managed parent remains 0700 on the host. The mounted copy itself is
    // writable by the configured non-root container user even when its UID does
    // not match the host runtime UID (for example on Docker Desktop).
    await fs.mkdir(workspacePath, { mode: 0o777 });
    await copyDirectory(config, workspaceRoot, workspacePath, "", workspaceRoot, summary);
    return { root: snapshotRoot, workspacePath, summary };
  } catch (error) {
    await fs.rm(snapshotRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function removeWorkspaceSnapshot(snapshotWorkspacePath: string): Promise<void> {
  const snapshotBase = await ensureSnapshotBase();
  let realWorkspacePath: string;
  try {
    realWorkspacePath = await fs.realpath(snapshotWorkspacePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const snapshotRoot = path.dirname(realWorkspacePath);
  if (
    path.basename(realWorkspacePath) !== "workspace" ||
    path.dirname(snapshotRoot) !== snapshotBase ||
    !isSubpath(snapshotBase, snapshotRoot)
  ) {
    throw new Error("Refusing to remove an unmanaged sandbox snapshot path");
  }
  await fs.rm(snapshotRoot, { recursive: true, force: true });
}

export async function isManagedWorkspaceSnapshot(snapshotWorkspacePath: string): Promise<boolean> {
  try {
    const snapshotBase = await ensureSnapshotBase();
    const realWorkspacePath = await fs.realpath(snapshotWorkspacePath);
    const snapshotRoot = path.dirname(realWorkspacePath);
    return path.basename(realWorkspacePath) === "workspace" && path.dirname(snapshotRoot) === snapshotBase;
  } catch {
    return false;
  }
}

async function ensureSnapshotBase(): Promise<string> {
  const candidate = path.join(os.tmpdir(), SNAPSHOT_BASE_NAME);
  await fs.mkdir(candidate, { recursive: true, mode: 0o700 });
  await fs.chmod(candidate, 0o700);
  return fs.realpath(candidate);
}

async function copyDirectory(
  config: RuntimeConfig,
  sourceDirectory: string,
  destinationDirectory: string,
  relativeDirectory: string,
  workspaceRoot: string,
  summary: WorkspaceSnapshotSummary
): Promise<void> {
  const realDirectory = await fs.realpath(sourceDirectory);
  if (!isSubpath(workspaceRoot, realDirectory)) {
    throw new Error(`Workspace directory escapes root while creating snapshot: ${relativeDirectory || "."}`);
  }

  const entries = await fs.readdir(sourceDirectory, { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (config.policy.denySecretsRead && isSecretLikeRelativePath(relativePath)) {
      summary.sensitiveEntriesSkipped += 1;
      continue;
    }

    const sourcePath = path.join(sourceDirectory, entry.name);
    const destinationPath = path.join(destinationDirectory, entry.name);
    let stat;
    try {
      stat = await fs.lstat(sourcePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }

    if (stat.isDirectory()) {
      await fs.mkdir(destinationPath, { mode: 0o777 });
      summary.directoriesCopied += 1;
      await copyDirectory(config, sourcePath, destinationPath, relativePath, workspaceRoot, summary);
      continue;
    }
    if (stat.isFile()) {
      const bytesCopied = await copyRegularFile(sourcePath, destinationPath, stat.mode);
      summary.filesCopied += 1;
      summary.bytesCopied += bytesCopied;
      continue;
    }
    if (stat.isSymbolicLink()) {
      const target = await fs.readlink(sourcePath);
      await fs.symlink(target, destinationPath);
      summary.symlinksCopied += 1;
      continue;
    }
    summary.specialEntriesSkipped += 1;
  }
}

async function copyRegularFile(sourcePath: string, destinationPath: string, sourceMode: number): Promise<number> {
  const source = await fs.open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let destination: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const stat = await source.stat();
    if (!stat.isFile()) throw new Error(`Snapshot source changed while copying: ${sourcePath}`);
    destination = await fs.open(
      destinationPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      (sourceMode & 0o111) | 0o666
    );
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let position = 0;
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(buffer, written, bytesRead - written, position + written);
        written += result.bytesWritten;
      }
      position += bytesRead;
    }
    await destination.chmod((sourceMode & 0o111) | 0o666);
    await destination.utimes(stat.atime, stat.mtime);
    return position;
  } finally {
    await destination?.close().catch(() => undefined);
    await source.close().catch(() => undefined);
  }
}

function isSubpath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
