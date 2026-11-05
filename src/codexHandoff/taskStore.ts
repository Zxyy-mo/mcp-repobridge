import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { RuntimeConfig } from "../config/config.js";
import { PolicyError } from "../policy/errors.js";
import { assertNotSecretLike, resolveWorkspacePath } from "../policy/pathPolicy.js";
import { captureGitWorkspaceState, sha256File } from "../utils/workspaceRevision.js";

export const CODEX_TASK_STATUSES = ["queued", "running", "succeeded", "failed", "canceled"] as const;
export type CodexTaskStatus = typeof CODEX_TASK_STATUSES[number];
export type CodexTaskPriority = "low" | "normal" | "high";

export type CodexTask = {
  schemaVersion: 1;
  id: string;
  status: CodexTaskStatus;
  title: string;
  prompt: string;
  acceptanceCriteria: string[];
  relevantFiles: string[];
  priority: CodexTaskPriority;
  createdAt: string;
  updatedAt: string;
  createdBy: "mcp";
  attempts: number;
  idempotencyKey?: string;
  baseline: {
    capturedAt: string;
    gitHead?: string;
    workspaceChanges: string[];
    relevantFiles: Array<{ path: string; sha256: string; size: number; mtimeMs: number }>;
  };
  worker?: {
    workerId: string;
    pid?: number;
    startedAt: string;
    command: string;
    args: string[];
  };
  result?: {
    finishedAt: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    truncated: boolean;
    canceled: boolean;
    stdoutTail: string;
    stderrTail: string;
    logPath: string;
    changedFiles: string[];
    preexistingChanges: string[];
    diffStat?: string;
    contextDrift?: Array<{ path: string; expectedSha256: string; actualSha256?: string; reason: string }>;
  };
  cancellation?: {
    requestedAt: string;
    reason?: string;
  };
};

export type CodexTaskView = Omit<CodexTask, "prompt"> & {
  promptPreview: string;
  prompt?: string;
};

export type CreateCodexTaskInput = {
  title: string;
  prompt: string;
  acceptanceCriteria?: string[];
  relevantFiles?: string[];
  priority?: CodexTaskPriority;
  idempotencyKey?: string;
};

export type CodexTaskQueuePaths = {
  queueRoot: string;
  tasksDir: string;
  logsDir: string;
  heartbeatsDir: string;
  idempotencyDir: string;
};

const TASK_ID_PATTERN = /^task_[0-9]{8}T[0-9]{6}Z_[a-f0-9]{8}$/;
const TERMINAL_STATUSES = new Set<CodexTaskStatus>(["succeeded", "failed", "canceled"]);
const idempotencyLocks = new Map<string, Promise<void>>();

export async function createCodexTask(
  config: RuntimeConfig,
  input: CreateCodexTaskInput
): Promise<{ task: CodexTask; reused: boolean }> {
  if (!input.idempotencyKey) return createCodexTaskUnlocked(config, input);
  const lockKey = `${config.workspace.root}\0${input.idempotencyKey.trim()}`;
  const previous = idempotencyLocks.get(lockKey) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  idempotencyLocks.set(lockKey, tail);
  await previous;
  try {
    return await createCodexTaskUnlocked(config, input);
  } finally {
    release();
    if (idempotencyLocks.get(lockKey) === tail) idempotencyLocks.delete(lockKey);
  }
}

async function createCodexTaskUnlocked(
  config: RuntimeConfig,
  input: CreateCodexTaskInput
): Promise<{ task: CodexTask; reused: boolean }> {
  ensureHandoffEnabled(config);
  const title = input.title.trim();
  const prompt = input.prompt.trim();
  if (!title) throw new PolicyError("Codex task title cannot be empty");
  if (!prompt) throw new PolicyError("Codex task prompt cannot be empty");
  if (Buffer.byteLength(title, "utf8") > 300) {
    throw new PolicyError("Codex task title exceeds 300 bytes");
  }
  if (Buffer.byteLength(prompt, "utf8") > config.codexHandoff.maxPromptBytes) {
    throw new PolicyError(`Codex task prompt exceeds ${config.codexHandoff.maxPromptBytes} bytes`);
  }

  const acceptanceCriteria = (input.acceptanceCriteria ?? [])
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 20);
  const relevantFiles = await normalizeRelevantFiles(config, input.relevantFiles ?? []);
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const requestDigest = createHash("sha256").update(JSON.stringify({
    title,
    prompt,
    acceptanceCriteria,
    relevantFiles,
    priority: input.priority ?? "normal"
  })).digest("hex");
  if (idempotencyKey) {
    const existing = await readIdempotencyRecord(config, idempotencyKey);
    if (existing) {
      if (existing.requestDigest !== requestDigest) {
        throw new PolicyError("Codex task idempotency key conflicts with different request content");
      }
      return { task: await readCodexTask(config, existing.taskId), reused: true };
    }
  }
  const git = await captureGitWorkspaceState(config.workspace.root);
  const relevantFileSnapshots = await Promise.all(relevantFiles.map(async (file) => ({
    path: file,
    ...await sha256File(path.join(config.workspace.root, file), config.workspace.maxHashBytes)
  })));
  const now = new Date().toISOString();
  const task: CodexTask = {
    schemaVersion: 1,
    id: makeTaskId(),
    status: "queued",
    title,
    prompt,
    acceptanceCriteria,
    relevantFiles,
    priority: input.priority ?? "normal",
    createdAt: now,
    updatedAt: now,
    createdBy: "mcp",
    attempts: 0,
    idempotencyKey,
    baseline: {
      capturedAt: now,
      gitHead: git?.head,
      workspaceChanges: git?.changes ?? [],
      relevantFiles: relevantFileSnapshots
    }
  };
  await writeTask(config, task);
  if (idempotencyKey) {
    await writeIdempotencyRecord(config, idempotencyKey, { taskId: task.id, requestDigest });
  }
  return { task, reused: false };
}

export async function listCodexTasks(
  config: RuntimeConfig,
  input: { status?: CodexTaskStatus; limit?: number } = {}
): Promise<CodexTask[]> {
  ensureHandoffEnabled(config);
  const { tasksDir } = await ensureQueuePaths(config);
  let entries: string[];
  try {
    entries = await fs.readdir(tasksDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const tasks = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .map(async (entry) => readTaskFile(path.join(tasksDir, entry)))
  );
  const limit = Math.min(input.limit ?? config.codexHandoff.maxTasksListed, config.codexHandoff.maxTasksListed);
  return tasks
    .filter((task) => !input.status || task.status === input.status)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, limit);
}

export async function readCodexTask(config: RuntimeConfig, taskId: string): Promise<CodexTask> {
  ensureHandoffEnabled(config);
  assertValidTaskId(taskId);
  return readTaskFile(await taskPath(config, taskId));
}

export async function cancelCodexTask(config: RuntimeConfig, taskId: string, reason?: string): Promise<CodexTask> {
  const task = await readCodexTask(config, taskId);
  if (TERMINAL_STATUSES.has(task.status)) return task;
  const now = new Date().toISOString();
  const updated: CodexTask = {
    ...task,
    status: task.status === "running" ? "running" : "canceled",
    updatedAt: now,
    cancellation: {
      requestedAt: now,
      reason: reason?.trim() || undefined
    }
  };
  await writeTask(config, updated);
  return updated;
}

export async function claimNextCodexTask(
  config: RuntimeConfig,
  worker: { workerId: string; pid?: number }
): Promise<CodexTask | undefined> {
  ensureHandoffEnabled(config);
  const tasks = await listCodexTasks(config, { status: "queued", limit: config.codexHandoff.maxTasksListed });
  for (const task of tasks.reverse()) {
    const latest = await readCodexTask(config, task.id);
    if (latest.status !== "queued") continue;
    const running: CodexTask = {
      ...latest,
      status: "running",
      attempts: latest.attempts + 1,
      updatedAt: new Date().toISOString(),
      worker: {
        workerId: worker.workerId,
        pid: worker.pid,
        startedAt: new Date().toISOString(),
        command: config.codexHandoff.codexCommand,
        args: config.codexHandoff.codexArgs
      }
    };
    await writeTask(config, running);
    return running;
  }
  return undefined;
}

export async function finishCodexTask(
  config: RuntimeConfig,
  taskId: string,
  status: Extract<CodexTaskStatus, "succeeded" | "failed" | "canceled">,
  result: CodexTask["result"]
): Promise<CodexTask> {
  if (!result) throw new Error("Codex task result is required");
  const task = await readCodexTask(config, taskId);
  const finished: CodexTask = {
    ...task,
    status,
    updatedAt: new Date().toISOString(),
    result
  };
  await writeTask(config, finished);
  return finished;
}

export async function writeCodexTaskLog(config: RuntimeConfig, taskId: string, content: string): Promise<string> {
  assertValidTaskId(taskId);
  const { logsDir } = await ensureQueuePaths(config);
  const logPath = path.join(logsDir, `${taskId}.log`);
  const tempPath = path.join(logsDir, `.${taskId}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tempPath, content, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tempPath, logPath);
  return path.relative(config.workspace.root, logPath).replace(/\\/g, "/");
}

export async function tailCodexTaskLog(
  config: RuntimeConfig,
  taskId: string,
  input: { offset?: number; bytes?: number } = {}
): Promise<{
  taskId: string;
  content: string;
  offset: number;
  nextOffset: number;
  totalBytes: number;
  bytesRead: number;
  truncated: boolean;
}> {
  assertValidTaskId(taskId);
  const { logsDir } = await ensureQueuePaths(config);
  const logPath = path.join(logsDir, `${taskId}.log`);
  const maxBytes = Math.min(input.bytes ?? config.codexHandoff.maxResultBytes, config.codexHandoff.maxResultBytes);
  let data: Buffer;
  if (input.offset !== undefined && input.offset < 0) throw new PolicyError("Codex task log offset must be non-negative");
  try {
    const handle = await fs.open(logPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new PolicyError("Codex task log is not a regular file");
      const start = input.offset === undefined
        ? Math.max(0, stat.size - maxBytes)
        : Math.min(input.offset, stat.size);
      const bytesToRead = Math.min(maxBytes, stat.size - start);
      data = Buffer.alloc(bytesToRead);
      const { bytesRead } = await handle.read(data, 0, data.length, start);
      const end = start + bytesRead;
      return {
        taskId,
        content: data.subarray(0, bytesRead).toString("utf8"),
        offset: start,
        nextOffset: end,
        totalBytes: stat.size,
        bytesRead,
        truncated: end < stat.size
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { taskId, content: "", offset: 0, nextOffset: 0, totalBytes: 0, bytesRead: 0, truncated: false };
    }
    throw error;
  }
}

export function taskToView(task: CodexTask, options: { includePrompt?: boolean } = {}): CodexTaskView {
  const promptPreview = task.prompt.length > 500 ? `${task.prompt.slice(0, 500)}...` : task.prompt;
  const view: CodexTaskView = {
    ...task,
    promptPreview
  };
  if (!options.includePrompt) {
    delete view.prompt;
  }
  return view;
}

export function assertValidTaskId(taskId: string): void {
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new PolicyError(`Invalid Codex task id: ${taskId}`);
  }
}

export function ensureHandoffEnabled(config: RuntimeConfig): void {
  if (!config.codexHandoff.enabled) {
    throw new PolicyError("Codex handoff is disabled by policy");
  }
}

async function normalizeRelevantFiles(config: RuntimeConfig, requestedFiles: string[]): Promise<string[]> {
  const normalized = new Set<string>();
  for (const requestedFile of requestedFiles.slice(0, 50)) {
    const resolved = await resolveWorkspacePath(config.workspace.root, requestedFile);
    assertNotSecretLike(config.workspace.root, resolved);
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) {
      throw new PolicyError(`Codex relevant file must be a regular file: ${requestedFile}`);
    }
    if (stat.size > config.workspace.maxHashBytes) {
      throw new PolicyError(
        `Codex relevant file exceeds the ${config.workspace.maxHashBytes} byte snapshot limit: ${requestedFile}`
      );
    }
    normalized.add(path.relative(config.workspace.root, resolved).replace(/\\/g, "/"));
  }
  return [...normalized].sort();
}

function normalizeIdempotencyKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(normalized)) {
    throw new PolicyError("Codex task idempotency key must use 1-200 safe ASCII characters");
  }
  return normalized;
}

async function readIdempotencyRecord(
  config: RuntimeConfig,
  key: string
): Promise<{ taskId: string; requestDigest: string } | undefined> {
  const { idempotencyDir } = await ensureQueuePaths(config);
  try {
    return JSON.parse(await readRegularFile(path.join(idempotencyDir, `${idempotencyFileId(key)}.json`)));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeIdempotencyRecord(
  config: RuntimeConfig,
  key: string,
  record: { taskId: string; requestDigest: string }
): Promise<void> {
  const { idempotencyDir } = await ensureQueuePaths(config);
  const destination = path.join(idempotencyDir, `${idempotencyFileId(key)}.json`);
  const temporary = path.join(idempotencyDir, `.${idempotencyFileId(key)}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await fs.rename(temporary, destination);
}

function idempotencyFileId(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

async function taskPath(config: RuntimeConfig, taskId: string): Promise<string> {
  const { tasksDir } = await ensureQueuePaths(config);
  return path.join(tasksDir, `${taskId}.json`);
}

async function writeTask(config: RuntimeConfig, task: CodexTask): Promise<void> {
  const { tasksDir } = await ensureQueuePaths(config);
  const destination = path.join(tasksDir, `${task.id}.json`);
  const tempPath = path.join(tasksDir, `.${task.id}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tempPath, `${JSON.stringify(task, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tempPath, destination);
}

async function readTaskFile(filePath: string): Promise<CodexTask> {
  const task = JSON.parse(await readRegularFile(filePath)) as CodexTask;
  assertValidTaskId(task.id);
  if (!CODEX_TASK_STATUSES.includes(task.status)) {
    throw new PolicyError(`Invalid Codex task status: ${task.status}`);
  }
  return task;
}

export async function ensureQueuePaths(config: RuntimeConfig): Promise<CodexTaskQueuePaths> {
  const workspaceRoot = await fs.realpath(config.workspace.root);
  const queueRoot = path.resolve(workspaceRoot, config.codexHandoff.queuePath);
  assertInsideWorkspace(workspaceRoot, queueRoot, "Codex queue path escapes workspace");
  await assertExistingAncestorInside(workspaceRoot, queueRoot);
  const tasksDir = path.join(queueRoot, "tasks");
  const logsDir = path.join(queueRoot, "logs");
  const heartbeatsDir = path.join(queueRoot, "worker-heartbeats");
  const idempotencyDir = path.join(queueRoot, "idempotency");
  await fs.mkdir(tasksDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(logsDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(heartbeatsDir, { recursive: true, mode: 0o700 });
  await fs.mkdir(idempotencyDir, { recursive: true, mode: 0o700 });
  const realQueueRoot = await fs.realpath(queueRoot);
  assertInsideWorkspace(workspaceRoot, realQueueRoot, "Codex queue realpath escapes workspace");
  const realTasksDir = await fs.realpath(tasksDir);
  const realLogsDir = await fs.realpath(logsDir);
  const realHeartbeatsDir = await fs.realpath(heartbeatsDir);
  const realIdempotencyDir = await fs.realpath(idempotencyDir);
  assertInsideWorkspace(workspaceRoot, realTasksDir, "Codex task directory realpath escapes workspace");
  assertInsideWorkspace(workspaceRoot, realLogsDir, "Codex log directory realpath escapes workspace");
  assertInsideWorkspace(workspaceRoot, realHeartbeatsDir, "Codex heartbeat directory realpath escapes workspace");
  assertInsideWorkspace(workspaceRoot, realIdempotencyDir, "Codex idempotency directory realpath escapes workspace");
  await Promise.all([realQueueRoot, realTasksDir, realLogsDir, realHeartbeatsDir, realIdempotencyDir]
    .map((candidate) => fs.chmod(candidate, 0o700)));
  return { queueRoot, tasksDir, logsDir, heartbeatsDir, idempotencyDir };
}

async function readRegularFile(filePath: string): Promise<string> {
  const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new PolicyError("Codex state file is not a regular file");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function assertInsideWorkspace(workspaceRoot: string, candidate: string, message: string): void {
  const relative = path.relative(workspaceRoot, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new PolicyError(message);
  }
}

async function assertExistingAncestorInside(workspaceRoot: string, candidate: string): Promise<void> {
  let current = candidate;
  while (true) {
    try {
      const realCurrent = await fs.realpath(current);
      assertInsideWorkspace(workspaceRoot, realCurrent, "Codex queue ancestor realpath escapes workspace");
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new PolicyError("Codex queue path has no existing workspace ancestor");
    }
    current = parent;
  }
}

function makeTaskId(): string {
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `task_${timestamp}_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}
