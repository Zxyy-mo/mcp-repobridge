import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { RuntimeConfig } from "../config/config.js";
import { spawnLimited } from "../utils/childProcess.js";
import {
  createSandboxTask,
  readSandboxTask,
  readSandboxTaskLogs,
  sandboxTaskLogPaths,
  writeSandboxTask,
  type SandboxTask
} from "./taskStore.js";

const TASK_WRAPPER = [
  "set -u",
  "task_dir=/tmp/mcp-repobridge-tasks",
  "mkdir -p \"$task_dir\"",
  "pid_file=\"$task_dir/$1.pid\"",
  "cleanup() { rm -f \"$pid_file\"; }",
  "trap cleanup EXIT",
  "setsid bash -lc \"$2\" &",
  "child=$!",
  "printf '%s\\n' \"$child\" > \"$pid_file\"",
  "wait \"$child\"",
  "exit $?"
].join("; ");

const TASK_TERMINATOR = [
  "set -u",
  "pid_file=\"/tmp/mcp-repobridge-tasks/$1.pid\"",
  "signal=$2",
  "case \"$signal\" in (TERM|KILL) ;; (*) exit 1;; esac",
  "test -f \"$pid_file\" || exit 0",
  "pid=$(cat \"$pid_file\")",
  "case \"$pid\" in (*[!0-9]*|'') exit 1;; esac",
  "kill -\"$signal\" -- \"-$pid\" 2>/dev/null || true"
].join("; ");

type ActiveSandboxTask = {
  child: ChildProcessWithoutNullStreams;
  task: SandboxTask;
  completion: Promise<SandboxTask>;
  cancelRequested: boolean;
  cancelReason?: string;
};

const activeTasks = new Map<string, ActiveSandboxTask>();

export async function runSandboxCommand(
  config: RuntimeConfig,
  input: {
    command: string;
    workdir: string;
    timeoutMs: number;
    yieldMs?: number;
    projectTask?: SandboxTask["projectTask"];
  }
) {
  const task = await createSandboxTask(config, input);
  const active = await launchTask(config, task);
  const yieldMs = Math.min(input.yieldMs ?? config.sandbox.commandYieldMs, input.timeoutMs);
  const completed = await Promise.race([
    active.completion.then(() => true),
    delay(yieldMs).then(() => false)
  ]);
  if (completed) return completedTaskResponse(config, await active.completion);
  void active.completion.catch(() => undefined);
  return {
    accepted: true,
    taskId: task.id,
    status: "running",
    nextAction: {
      tool: "sandbox_task_status",
      arguments: { taskId: task.id },
      reason: "The command is still running; query its durable task record."
    }
  };
}

export async function sandboxTaskStatus(config: RuntimeConfig, taskId: string) {
  let task = await readSandboxTask(config, taskId);
  if (task.status === "running" && !activeTasks.has(taskId)) {
    await terminateOrphanContainerTask(config, taskId);
    task = {
      ...task,
      status: "interrupted",
      updatedAt: new Date().toISOString(),
      result: {
        finishedAt: new Date().toISOString(),
        exitCode: null,
        signal: null,
        timedOut: false,
        truncated: false,
        stdoutBytes: 0,
        stderrBytes: 0
      }
    };
    await writeSandboxTask(config, task);
  }
  return {
    task,
    nextAction: task.status === "running"
      ? {
        tool: "sandbox_task_tail",
        arguments: { taskId },
        reason: "Read new output while the sandbox command continues."
      }
      : undefined
  };
}

export async function sandboxTaskTail(
  config: RuntimeConfig,
  input: { taskId: string; stdoutOffset?: number; stderrOffset?: number; maxBytes?: number }
) {
  const task = await readSandboxTask(config, input.taskId);
  const logs = await readSandboxTaskLogs(config, input.taskId, input);
  const hasMore = logs.stdout.truncated || logs.stderr.truncated || task.status === "running";
  return {
    status: task.status,
    ...logs,
    nextAction: hasMore
      ? {
        tool: "sandbox_task_tail",
        arguments: {
          taskId: input.taskId,
          stdoutOffset: logs.stdout.nextOffset,
          stderrOffset: logs.stderr.nextOffset,
          maxBytes: input.maxBytes
        },
        reason: task.status === "running"
          ? "Wait briefly, then continue reading from the returned log offsets."
          : "Continue reading the remaining persisted task output."
      }
      : undefined
  };
}

export async function cancelSandboxTask(config: RuntimeConfig, taskId: string, reason?: string) {
  const task = await readSandboxTask(config, taskId);
  if (task.status !== "running") return { task };
  const active = activeTasks.get(taskId);
  const cancellation = { requestedAt: new Date().toISOString(), reason: reason?.trim() || undefined };
  await writeSandboxTask(config, { ...task, updatedAt: cancellation.requestedAt, cancellation });
  if (active) {
    active.cancelRequested = true;
    active.cancelReason = cancellation.reason;
    await terminateContainerTask(config, taskId, "TERM");
    const completed = await Promise.race([
      active.completion.then(() => true),
      delay(config.sandbox.taskCancelGraceMs + 1000).then(() => false)
    ]);
    if (!completed) {
      await terminateContainerTask(config, taskId, "KILL");
      active.child.kill("SIGKILL");
    }
    return { task: completed ? await active.completion : await readSandboxTask(config, taskId) };
  }
  await terminateOrphanContainerTask(config, taskId);
  const canceled: SandboxTask = {
    ...task,
    status: "canceled",
    updatedAt: new Date().toISOString(),
    cancellation,
    result: {
      finishedAt: new Date().toISOString(),
      exitCode: null,
      signal: null,
      timedOut: false,
      truncated: false,
      stdoutBytes: 0,
      stderrBytes: 0
    }
  };
  await writeSandboxTask(config, canceled);
  return { task: canceled };
}

async function launchTask(config: RuntimeConfig, task: SandboxTask): Promise<ActiveSandboxTask> {
  const logPaths = await sandboxTaskLogPaths(config, task.id);
  const [stdoutHandle, stderrHandle] = await Promise.all([
    fs.open(logPaths.stdout, "a"),
    fs.open(logPaths.stderr, "a")
  ]);
  const stdoutSink = createLogSink(stdoutHandle, config.sandbox.maxTaskLogBytes);
  const stderrSink = createLogSink(stderrHandle, config.sandbox.maxTaskLogBytes);
  const child = spawn("docker", [
    "exec",
    "-i",
    "--workdir",
    task.workdir,
    config.sandbox.containerName,
    "bash",
    "-lc",
    TASK_WRAPPER,
    "mcp-task-wrapper",
    task.id,
    task.command
  ], {
    shell: false,
    env: { PATH: process.env.PATH ?? "" }
  });

  let timedOut = false;
  let settled = false;
  let resolveCompletion!: (task: SandboxTask) => void;
  let rejectCompletion!: (error: unknown) => void;
  const completion = new Promise<SandboxTask>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  const active: ActiveSandboxTask = {
    child,
    task,
    completion,
    cancelRequested: false
  };
  activeTasks.set(task.id, active);

  child.stdout.on("data", (chunk: Buffer) => stdoutSink.append(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderrSink.append(chunk));
  child.stdin.on("error", () => undefined);
  child.stdin.end();

  const timeout = setTimeout(() => {
    timedOut = true;
    void terminateContainerTask(config, task.id, "TERM").finally(() => {
      const killer = setTimeout(() => {
        void terminateContainerTask(config, task.id, "KILL").finally(() => child.kill("SIGKILL"));
      }, config.sandbox.taskCancelGraceMs);
      killer.unref();
    });
  }, task.timeoutMs);
  timeout.unref();

  const finalize = async (code: number | null, signal: NodeJS.Signals | null, spawnError?: unknown) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    try {
      if (spawnError) stderrSink.append(Buffer.from(spawnError instanceof Error ? spawnError.message : String(spawnError)));
      await Promise.all([stdoutSink.close(), stderrSink.close()]);
      const status = active.cancelRequested ? "canceled" : code === 0 && !timedOut ? "succeeded" : "failed";
      const finished: SandboxTask = {
        ...task,
        status,
        updatedAt: new Date().toISOString(),
        cancellation: active.cancelRequested
          ? { requestedAt: new Date().toISOString(), reason: active.cancelReason }
          : undefined,
        result: {
          finishedAt: new Date().toISOString(),
          exitCode: code,
          signal,
          timedOut,
          truncated: stdoutSink.truncated() || stderrSink.truncated(),
          stdoutBytes: stdoutSink.bytesWritten(),
          stderrBytes: stderrSink.bytesWritten()
        }
      };
      await writeSandboxTask(config, finished);
      activeTasks.delete(task.id);
      resolveCompletion(finished);
    } catch (error) {
      activeTasks.delete(task.id);
      rejectCompletion(error);
    }
  };

  child.on("error", (error) => void finalize(null, null, error));
  child.on("close", (code, signal) => void finalize(code, signal));
  return active;
}

async function completedTaskResponse(config: RuntimeConfig, task: SandboxTask) {
  const logs = await readSandboxTaskLogs(config, task.id);
  return {
    accepted: false,
    taskId: task.id,
    status: task.status,
    code: task.result?.exitCode ?? null,
    signal: task.result?.signal ?? null,
    stdout: logs.stdout.content,
    stderr: logs.stderr.content,
    timedOut: task.result?.timedOut ?? false,
    truncated: task.result?.truncated ?? false
  };
}

async function terminateOrphanContainerTask(config: RuntimeConfig, taskId: string): Promise<void> {
  await terminateContainerTask(config, taskId, "TERM");
  await delay(config.sandbox.taskCancelGraceMs);
  await terminateContainerTask(config, taskId, "KILL");
}

async function terminateContainerTask(
  config: RuntimeConfig,
  taskId: string,
  signal: "TERM" | "KILL"
): Promise<void> {
  await spawnLimited("docker", [
    "exec",
    config.sandbox.containerName,
    "bash",
    "-lc",
    TASK_TERMINATOR,
    "mcp-task-terminator",
    taskId,
    signal
  ], {
    timeoutMs: config.sandbox.taskCancelGraceMs,
    maxOutputBytes: 4096,
    env: { PATH: process.env.PATH ?? "" }
  }).catch(() => undefined);
}

function createLogSink(handle: FileHandle, maxBytes: number) {
  let queue = Promise.resolve();
  let stored = 0;
  let wasTruncated = false;
  return {
    append(chunk: Buffer) {
      const remaining = Math.max(0, maxBytes - stored);
      if (chunk.length > remaining) wasTruncated = true;
      if (remaining === 0) return;
      const selected = chunk.subarray(0, remaining);
      stored += selected.length;
      queue = queue.then(async () => {
        await handle.write(selected);
      });
    },
    async close() {
      await queue;
      await handle.close();
    },
    bytesWritten: () => stored,
    truncated: () => wasTruncated
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}
