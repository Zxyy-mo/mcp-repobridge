import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { RuntimeConfig } from "../config/config.js";
import { PolicyError } from "../policy/errors.js";
import { assertNotSecretLike, resolveWorkspacePath } from "../policy/pathPolicy.js";

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
    stdoutTail: string;
    stderrTail: string;
    logPath: string;
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
};

export type CodexTaskQueuePaths = {
  queueRoot: string;
  tasksDir: string;
  logsDir: string;
};

const TASK_ID_PATTERN = /^task_[0-9]{8}T[0-9]{6}Z_[a-f0-9]{8}$/;
const TERMINAL_STATUSES = new Set<CodexTaskStatus>(["succeeded", "failed", "canceled"]);

export async function createCodexTask(config: RuntimeConfig, input: CreateCodexTaskInput): Promise<CodexTask> {
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
    attempts: 0
  };
  await writeTask(config, task);
  return task;
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
  if (task.status === "running") {
    throw new PolicyError("Running Codex tasks cannot be canceled through MCP; stop the local worker instead");
  }
  const now = new Date().toISOString();
  const canceled: CodexTask = {
    ...task,
    status: "canceled",
    updatedAt: now,
    cancellation: {
      requestedAt: now,
      reason: reason?.trim() || undefined
    }
  };
  await writeTask(config, canceled);
  return canceled;
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
  status: Extract<CodexTaskStatus, "succeeded" | "failed">,
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
  bytes?: number
): Promise<{ taskId: string; content: string; bytesRead: number; truncated: boolean }> {
  assertValidTaskId(taskId);
  const { logsDir } = await ensureQueuePaths(config);
  const logPath = path.join(logsDir, `${taskId}.log`);
  const maxBytes = Math.min(bytes ?? config.codexHandoff.maxResultBytes, config.codexHandoff.maxResultBytes);
  let data: Buffer;
  try {
    const stat = await fs.lstat(logPath);
    if (!stat.isFile()) throw new PolicyError("Codex task log is not a regular file");
    data = await fs.readFile(logPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { taskId, content: "", bytesRead: 0, truncated: false };
    }
    throw error;
  }
  const start = Math.max(0, data.length - maxBytes);
  return {
    taskId,
    content: data.subarray(start).toString("utf8"),
    bytesRead: data.length - start,
    truncated: start > 0
  };
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
    normalized.add(path.relative(config.workspace.root, resolved).replace(/\\/g, "/"));
  }
  return [...normalized].sort();
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
  const stat = await fs.lstat(filePath);
  if (!stat.isFile()) throw new PolicyError("Codex task record is not a regular file");
  const task = JSON.parse(await fs.readFile(filePath, "utf8")) as CodexTask;
  assertValidTaskId(task.id);
  if (!CODEX_TASK_STATUSES.includes(task.status)) {
    throw new PolicyError(`Invalid Codex task status: ${task.status}`);
  }
  return task;
}

async function ensureQueuePaths(config: RuntimeConfig): Promise<CodexTaskQueuePaths> {
  const workspaceRoot = await fs.realpath(config.workspace.root);
  const queueRoot = path.resolve(workspaceRoot, config.codexHandoff.queuePath);
  assertInsideWorkspace(workspaceRoot, queueRoot, "Codex queue path escapes workspace");
  await assertExistingAncestorInside(workspaceRoot, queueRoot);
  const tasksDir = path.join(queueRoot, "tasks");
  const logsDir = path.join(queueRoot, "logs");
  await fs.mkdir(tasksDir, { recursive: true });
  await fs.mkdir(logsDir, { recursive: true });
  const realQueueRoot = await fs.realpath(queueRoot);
  assertInsideWorkspace(workspaceRoot, realQueueRoot, "Codex queue realpath escapes workspace");
  const realTasksDir = await fs.realpath(tasksDir);
  const realLogsDir = await fs.realpath(logsDir);
  assertInsideWorkspace(workspaceRoot, realTasksDir, "Codex task directory realpath escapes workspace");
  assertInsideWorkspace(workspaceRoot, realLogsDir, "Codex log directory realpath escapes workspace");
  return { queueRoot, tasksDir, logsDir };
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
