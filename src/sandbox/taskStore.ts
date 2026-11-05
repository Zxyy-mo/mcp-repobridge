import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { RuntimeConfig } from "../config/config.js";
import { PolicyError } from "../policy/errors.js";

export const SANDBOX_TASK_STATUSES = ["running", "succeeded", "failed", "canceled", "interrupted"] as const;
export type SandboxTaskStatus = typeof SANDBOX_TASK_STATUSES[number];

export type SandboxTask = {
  schemaVersion: 1;
  id: string;
  status: SandboxTaskStatus;
  command: string;
  workdir: string;
  createdAt: string;
  updatedAt: string;
  timeoutMs: number;
  projectTask?: {
    name: string;
    kind: string;
    source: string;
  };
  result?: {
    finishedAt: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    truncated: boolean;
    stdoutBytes: number;
    stderrBytes: number;
  };
  cancellation?: {
    requestedAt: string;
    reason?: string;
  };
};

export type SandboxTaskPaths = {
  root: string;
  tasksDir: string;
  logsDir: string;
};

const TASK_ID_PATTERN = /^sandbox_[0-9]{8}T[0-9]{6}Z_[a-f0-9]{8}$/;

export async function createSandboxTask(
  config: RuntimeConfig,
  input: {
    command: string;
    workdir: string;
    timeoutMs: number;
    projectTask?: SandboxTask["projectTask"];
  }
): Promise<SandboxTask> {
  const now = new Date().toISOString();
  const task: SandboxTask = {
    schemaVersion: 1,
    id: makeTaskId(),
    status: "running",
    command: input.command,
    workdir: input.workdir,
    timeoutMs: input.timeoutMs,
    projectTask: input.projectTask,
    createdAt: now,
    updatedAt: now
  };
  const paths = await ensureSandboxTaskPaths(config);
  await Promise.all([
    fs.writeFile(stdoutLogPath(paths, task.id), "", { mode: 0o600 }),
    fs.writeFile(stderrLogPath(paths, task.id), "", { mode: 0o600 })
  ]);
  await writeSandboxTask(config, task);
  return task;
}

export async function readSandboxTask(config: RuntimeConfig, taskId: string): Promise<SandboxTask> {
  assertSandboxTaskId(taskId);
  const paths = await ensureSandboxTaskPaths(config);
  const record = JSON.parse(await readRegularFile(path.join(paths.tasksDir, `${taskId}.json`))) as SandboxTask;
  assertSandboxTaskId(record.id);
  if (!SANDBOX_TASK_STATUSES.includes(record.status)) throw new PolicyError("Invalid sandbox task status");
  return record;
}

export async function writeSandboxTask(config: RuntimeConfig, task: SandboxTask): Promise<void> {
  assertSandboxTaskId(task.id);
  const paths = await ensureSandboxTaskPaths(config);
  const destination = path.join(paths.tasksDir, `${task.id}.json`);
  const temporary = path.join(paths.tasksDir, `.${task.id}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(task, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, destination);
}

export async function sandboxTaskLogPaths(config: RuntimeConfig, taskId: string) {
  assertSandboxTaskId(taskId);
  const paths = await ensureSandboxTaskPaths(config);
  return { stdout: stdoutLogPath(paths, taskId), stderr: stderrLogPath(paths, taskId) };
}

export async function readSandboxTaskLogs(
  config: RuntimeConfig,
  taskId: string,
  input: { stdoutOffset?: number; stderrOffset?: number; maxBytes?: number } = {}
) {
  await readSandboxTask(config, taskId);
  const paths = await sandboxTaskLogPaths(config, taskId);
  const maxBytes = Math.min(input.maxBytes ?? config.sandbox.maxOutputBytes, config.sandbox.maxOutputBytes);
  const [stdout, stderr] = await Promise.all([
    readLogRange(paths.stdout, input.stdoutOffset ?? 0, maxBytes),
    readLogRange(paths.stderr, input.stderrOffset ?? 0, maxBytes)
  ]);
  return { taskId, stdout, stderr };
}

export async function ensureSandboxTaskPaths(config: RuntimeConfig): Promise<SandboxTaskPaths> {
  const workspaceRoot = await fs.realpath(config.workspace.root);
  const root = path.resolve(workspaceRoot, config.sandbox.taskPath);
  assertInside(workspaceRoot, root);
  await assertExistingAncestorInside(workspaceRoot, root);
  const tasksDir = path.join(root, "tasks");
  const logsDir = path.join(root, "logs");
  await fs.mkdir(tasksDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(logsDir, { recursive: true, mode: 0o700 });
  for (const candidate of [root, tasksDir, logsDir]) {
    assertInside(workspaceRoot, await fs.realpath(candidate));
    await fs.chmod(candidate, 0o700);
  }
  return { root, tasksDir, logsDir };
}

export function assertSandboxTaskId(taskId: string): void {
  if (!TASK_ID_PATTERN.test(taskId)) throw new PolicyError(`Invalid sandbox task id: ${taskId}`);
}

async function readLogRange(filePath: string, offset: number, maxBytes: number) {
  if (offset < 0) throw new PolicyError("Log offset must be non-negative");
  const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new PolicyError("Sandbox task log is not a regular file");
    const start = Math.min(offset, stat.size);
    const bytesToRead = Math.min(maxBytes, stat.size - start);
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const nextOffset = start + bytesRead;
    return {
      content: buffer.subarray(0, bytesRead).toString("utf8"),
      offset: start,
      nextOffset,
      totalBytes: stat.size,
      truncated: nextOffset < stat.size
    };
  } finally {
    await handle.close();
  }
}

async function readRegularFile(filePath: string): Promise<string> {
  const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new PolicyError("Sandbox task record is not a regular file");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function stdoutLogPath(paths: SandboxTaskPaths, taskId: string): string {
  return path.join(paths.logsDir, `${taskId}.stdout.log`);
}

function stderrLogPath(paths: SandboxTaskPaths, taskId: string): string {
  return path.join(paths.logsDir, `${taskId}.stderr.log`);
}

function makeTaskId(): string {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `sandbox_${timestamp}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

function assertInside(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new PolicyError("Sandbox task path escapes workspace");
  }
}

async function assertExistingAncestorInside(workspaceRoot: string, candidate: string): Promise<void> {
  let current = candidate;
  while (true) {
    try {
      assertInside(workspaceRoot, await fs.realpath(current));
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) throw new PolicyError("Sandbox task path has no workspace ancestor");
    current = parent;
  }
}
