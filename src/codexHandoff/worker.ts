import { spawn } from "node:child_process";
import type { RuntimeConfig } from "../config/config.js";
import { writeAudit } from "../audit/auditLog.js";
import {
  claimNextCodexTask,
  finishCodexTask,
  readCodexTask,
  writeCodexTaskLog,
  type CodexTask
} from "./taskStore.js";
import { writeWorkerHeartbeat } from "./workerHeartbeat.js";
import { captureGitWorkspaceState, sha256File } from "../utils/workspaceRevision.js";
import path from "node:path";

type ProcessNextOptions = {
  workerId?: string;
};

type ProcessNextResult = {
  processed: boolean;
  taskId?: string;
  status?: "succeeded" | "failed" | "canceled";
};

type SpawnWithInputResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  canceled: boolean;
};

const SENSITIVE_ENV_NAME_PATTERN = /(?:SECRET|TOKEN|KEY|CREDENTIAL|PASSWORD|AUTH)/i;

export async function processNextCodexTask(
  config: RuntimeConfig,
  options: ProcessNextOptions = {}
): Promise<ProcessNextResult> {
  const workerId = options.workerId ?? `codex-worker-${process.pid}`;
  await writeWorkerHeartbeat(config, { workerId, pid: process.pid, status: "idle" });
  const task = await claimNextCodexTask(config, { workerId, pid: process.pid });
  if (!task) return { processed: false };

  await writeWorkerHeartbeat(config, { workerId, pid: process.pid, status: "running", taskId: task.id });
  const heartbeatTimer = setInterval(() => {
    void writeWorkerHeartbeat(config, {
      workerId,
      pid: process.pid,
      status: "running",
      taskId: task.id
    }).catch(() => undefined);
  }, config.codexHandoff.workerHeartbeatIntervalMs);
  heartbeatTimer.unref();
  let result: NonNullable<CodexTask["result"]>;
  try {
    const contextDrift = await detectContextDrift(config, task);
    result = contextDrift.length > 0 && config.codexHandoff.failOnContextDrift
      ? await contextDriftResult(config, task, contextDrift)
      : await runCodexTask(config, task);
  } finally {
    clearInterval(heartbeatTimer);
  }
  const status = result.canceled ? "canceled" : result.exitCode === 0 && !result.timedOut ? "succeeded" : "failed";
  await finishCodexTask(config, task.id, status, result);
  await writeAudit(config, {
    timestamp: new Date().toISOString(),
    tool: "codex_worker_run",
    action: status === "succeeded" ? "allow" : "deny",
    summary: {
      taskId: task.id,
      title: task.title,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      truncated: result.truncated,
      canceled: result.canceled,
      changedFiles: result.changedFiles
    },
    exitCode: result.exitCode,
    stdoutBytes: Buffer.byteLength(result.stdoutTail, "utf8"),
    stderrBytes: Buffer.byteLength(result.stderrTail, "utf8")
  });
  await writeWorkerHeartbeat(config, { workerId, pid: process.pid, status: "idle" });
  return { processed: true, taskId: task.id, status };
}

export function renderCodexTaskPrompt(task: CodexTask, workspaceRoot: string): string {
  const acceptanceCriteria = task.acceptanceCriteria.length > 0
    ? task.acceptanceCriteria.map((entry, index) => `${index + 1}. ${entry}`).join("\n")
    : "No explicit acceptance criteria were provided. Use the task prompt and repository context.";
  const relevantFiles = task.relevantFiles.length > 0
    ? task.relevantFiles.map((entry) => `- ${entry}`).join("\n")
    : "No specific files were provided.";

  return [
    "You are Codex running as a local worker for a ChatGPT MCP handoff task.",
    "Work in the existing repository and current git branch. Do not push changes unless the task explicitly asks for it.",
    "Make the requested code changes, run the most relevant checks you can, and finish with a concise summary.",
    "",
    `Workspace root: ${workspaceRoot}`,
    `Task id: ${task.id}`,
    `Priority: ${task.priority}`,
    `Title: ${task.title}`,
    "",
    "Relevant files:",
    relevantFiles,
    "",
    "Acceptance criteria:",
    acceptanceCriteria,
    "",
    "Task prompt:",
    task.prompt
  ].join("\n");
}

async function runCodexTask(config: RuntimeConfig, task: CodexTask): Promise<NonNullable<CodexTask["result"]>> {
  const prompt = renderCodexTaskPrompt(task, config.workspace.root);
  const startedAt = new Date().toISOString();
  let result: SpawnWithInputResult;
  try {
    result = await spawnWithInput(
      config.codexHandoff.codexCommand,
      config.codexHandoff.codexArgs,
      prompt,
      {
        cwd: config.workspace.root,
        timeoutMs: config.codexHandoff.taskTimeoutMs,
        maxOutputBytes: config.codexHandoff.maxResultBytes,
        env: buildCodexWorkerEnv(
          process.env,
          config.codexHandoff.allowedEnvKeys,
          config.codexHandoff.allowedEnvPrefixes
        ),
        cancellationPollIntervalMs: config.codexHandoff.cancellationPollIntervalMs,
        cancellationGraceMs: config.codexHandoff.cancellationGraceMs,
        shouldCancel: async () => Boolean((await readTaskCancellation(config, task.id)))
      }
    );
  } catch (error) {
    result = {
      code: null,
      signal: null,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      timedOut: false,
      truncated: false,
      canceled: false
    };
  }

  const finishedAt = new Date().toISOString();
  const git = await captureGitWorkspaceState(config.workspace.root);
  const preexistingChanges = task.baseline?.workspaceChanges ?? [];
  const changedFiles = git?.changes ?? [];
  const logPath = await writeCodexTaskLog(config, task.id, [
    `Task: ${task.id}`,
    `Title: ${task.title}`,
    `Started: ${startedAt}`,
    `Finished: ${finishedAt}`,
    `Command: ${config.codexHandoff.codexCommand} ${config.codexHandoff.codexArgs.join(" ")}`,
    `Exit code: ${result.code}`,
    `Signal: ${result.signal ?? ""}`,
    `Timed out: ${result.timedOut}`,
    `Truncated: ${result.truncated}`,
    `Canceled: ${result.canceled}`,
    `Changed files: ${changedFiles.join(", ") || "none detected"}`,
    git?.diffStat ? `Diff stat:\n${git.diffStat}` : "Diff stat: none",
    "",
    "STDOUT:",
    result.stdout,
    "",
    "STDERR:",
    result.stderr
  ].join("\n"));

  return {
    finishedAt,
    exitCode: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    truncated: result.truncated,
    canceled: result.canceled,
    stdoutTail: tailText(result.stdout, config.codexHandoff.maxResultBytes),
    stderrTail: tailText(result.stderr, config.codexHandoff.maxResultBytes),
    logPath,
    changedFiles,
    preexistingChanges,
    diffStat: git?.diffStat
  };
}

async function spawnWithInput(
  command: string,
  args: string[],
  input: string,
  options: {
    cwd: string;
    timeoutMs: number;
    maxOutputBytes: number;
    env: NodeJS.ProcessEnv;
    cancellationPollIntervalMs: number;
    cancellationGraceMs: number;
    shouldCancel: () => Promise<boolean>;
  }
): Promise<SpawnWithInputResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      env: options.env,
      detached: process.platform !== "win32"
    });

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let truncated = false;
    let timeoutFired = false;
    let killedForOutputLimit = false;
    let canceled = false;
    let settled = false;
    let cancellationKillTimer: NodeJS.Timeout | undefined;

    const timer = setTimeout(() => {
      timeoutFired = true;
      terminateChild(child, "SIGKILL");
    }, options.timeoutMs);

    let cancellationCheckRunning = false;
    const cancellationTimer = setInterval(() => {
      if (cancellationCheckRunning || canceled || settled) return;
      cancellationCheckRunning = true;
      void options.shouldCancel().then((requested) => {
        if (requested && !settled) {
          canceled = true;
          terminateChild(child, "SIGTERM");
          cancellationKillTimer = setTimeout(() => {
            if (!settled) terminateChild(child, "SIGKILL");
          }, options.cancellationGraceMs);
          cancellationKillTimer.unref();
        }
      }).finally(() => {
        cancellationCheckRunning = false;
      });
    }, options.cancellationPollIntervalMs);
    cancellationTimer.unref();

    const append = (current: Buffer, chunk: Buffer) => {
      const next = Buffer.concat([current, chunk]);
      if (next.length > options.maxOutputBytes) {
        truncated = true;
        if (!killedForOutputLimit) {
          killedForOutputLimit = true;
          terminateChild(child, "SIGKILL");
        }
        return next.subarray(next.length - options.maxOutputBytes);
      }
      return next;
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        clearInterval(cancellationTimer);
        if (cancellationKillTimer) clearTimeout(cancellationKillTimer);
        reject(error);
      }
    });
    child.on("close", (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        clearInterval(cancellationTimer);
        if (cancellationKillTimer) clearTimeout(cancellationKillTimer);
        resolve({
          code,
          signal,
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
          timedOut: timeoutFired,
          truncated,
          canceled
        });
      }
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") {
        terminateChild(child, "SIGKILL");
      }
    });
    child.stdin.end(input);
  });
}

async function detectContextDrift(
  config: RuntimeConfig,
  task: CodexTask
): Promise<NonNullable<NonNullable<CodexTask["result"]>["contextDrift"]>> {
  const drift: NonNullable<NonNullable<CodexTask["result"]>["contextDrift"]> = [];
  for (const expected of task.baseline?.relevantFiles ?? []) {
    try {
      const actual = await sha256File(
        path.join(config.workspace.root, expected.path),
        config.workspace.maxHashBytes
      );
      if (actual.sha256 !== expected.sha256) {
        drift.push({
          path: expected.path,
          expectedSha256: expected.sha256,
          actualSha256: actual.sha256,
          reason: "content_changed"
        });
      }
    } catch {
      drift.push({
        path: expected.path,
        expectedSha256: expected.sha256,
        reason: "missing_or_unreadable"
      });
    }
  }
  return drift;
}

async function contextDriftResult(
  config: RuntimeConfig,
  task: CodexTask,
  contextDrift: NonNullable<NonNullable<CodexTask["result"]>["contextDrift"]>
): Promise<NonNullable<CodexTask["result"]>> {
  const finishedAt = new Date().toISOString();
  const message = `Task stopped before Codex execution because ${contextDrift.length} relevant file(s) changed after queueing.`;
  const logPath = await writeCodexTaskLog(config, task.id, [
    `Task: ${task.id}`,
    `Title: ${task.title}`,
    `Finished: ${finishedAt}`,
    "Outcome: context drift",
    message,
    JSON.stringify(contextDrift, null, 2)
  ].join("\n"));
  return {
    finishedAt,
    exitCode: null,
    signal: null,
    timedOut: false,
    truncated: false,
    canceled: false,
    stdoutTail: "",
    stderrTail: message,
    logPath,
    changedFiles: [],
    preexistingChanges: task.baseline?.workspaceChanges ?? [],
    contextDrift
  };
}

async function readTaskCancellation(config: RuntimeConfig, taskId: string) {
  try {
    return (await readCodexTask(config, taskId)).cancellation;
  } catch {
    return undefined;
  }
}

function terminateChild(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child when the process group no longer exists.
    }
  }
  child.kill(signal);
}

export function buildCodexWorkerEnv(
  source: NodeJS.ProcessEnv,
  allowedKeys: string[],
  allowedPrefixes: string[]
): NodeJS.ProcessEnv {
  const allowedKeySet = new Set(allowedKeys);
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (SENSITIVE_ENV_NAME_PATTERN.test(key)) continue;
    if (allowedKeySet.has(key) || allowedPrefixes.some((prefix) => key.startsWith(prefix))) {
      result[key] = value;
    }
  }
  return result;
}

function tailText(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return value;
  return buffer.subarray(buffer.length - maxBytes).toString("utf8");
}
