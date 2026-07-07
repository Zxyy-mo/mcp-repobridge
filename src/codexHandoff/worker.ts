import { spawn } from "node:child_process";
import type { RuntimeConfig } from "../config/config.js";
import { writeAudit } from "../audit/auditLog.js";
import {
  claimNextCodexTask,
  finishCodexTask,
  writeCodexTaskLog,
  type CodexTask
} from "./taskStore.js";

type ProcessNextOptions = {
  workerId?: string;
};

type ProcessNextResult = {
  processed: boolean;
  taskId?: string;
  status?: "succeeded" | "failed";
};

type SpawnWithInputResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
};

export async function processNextCodexTask(
  config: RuntimeConfig,
  options: ProcessNextOptions = {}
): Promise<ProcessNextResult> {
  const workerId = options.workerId ?? `codex-worker-${process.pid}`;
  const task = await claimNextCodexTask(config, { workerId, pid: process.pid });
  if (!task) return { processed: false };

  const result = await runCodexTask(config, task);
  const status = result.exitCode === 0 && !result.timedOut ? "succeeded" : "failed";
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
      truncated: result.truncated
    },
    exitCode: result.exitCode,
    stdoutBytes: Buffer.byteLength(result.stdoutTail, "utf8"),
    stderrBytes: Buffer.byteLength(result.stderrTail, "utf8")
  });
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
        maxOutputBytes: config.codexHandoff.maxResultBytes
      }
    );
  } catch (error) {
    result = {
      code: null,
      signal: null,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      timedOut: false,
      truncated: false
    };
  }

  const finishedAt = new Date().toISOString();
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
    stdoutTail: tailText(result.stdout, config.codexHandoff.maxResultBytes),
    stderrTail: tailText(result.stderr, config.codexHandoff.maxResultBytes),
    logPath
  };
}

async function spawnWithInput(
  command: string,
  args: string[],
  input: string,
  options: { cwd: string; timeoutMs: number; maxOutputBytes: number }
): Promise<SpawnWithInputResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      env: process.env
    });

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let truncated = false;
    let timeoutFired = false;
    let killedForOutputLimit = false;
    let settled = false;

    const timer = setTimeout(() => {
      timeoutFired = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);

    const append = (current: Buffer, chunk: Buffer) => {
      const next = Buffer.concat([current, chunk]);
      if (next.length > options.maxOutputBytes) {
        truncated = true;
        if (!killedForOutputLimit) {
          killedForOutputLimit = true;
          child.kill("SIGKILL");
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
        reject(error);
      }
    });
    child.on("close", (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          code,
          signal,
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
          timedOut: timeoutFired,
          truncated
        });
      }
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE") {
        child.kill("SIGKILL");
      }
    });
    child.stdin.end(input);
  });
}

function tailText(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return value;
  return buffer.subarray(buffer.length - maxBytes).toString("utf8");
}
