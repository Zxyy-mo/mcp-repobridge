import type { RuntimeConfig } from "../config/config.js";
import { auditToolCall } from "../audit/auditLog.js";
import {
  cancelCodexTask,
  createCodexTask,
  listCodexTasks,
  readCodexTask,
  tailCodexTaskLog,
  taskToView,
  type CodexTaskPriority,
  type CodexTaskStatus
} from "../codexHandoff/taskStore.js";
import { listWorkerHeartbeats } from "../codexHandoff/workerHeartbeat.js";

export async function codexTaskCreateTool(
  config: RuntimeConfig,
  input: {
    title: string;
    prompt: string;
    acceptanceCriteria?: string[];
    relevantFiles?: string[];
    priority?: CodexTaskPriority;
    idempotencyKey?: string;
  }
) {
  return auditToolCall(
    config,
    "codex_task_create",
    {
      title: input.title.slice(0, 120),
      relevantFileCount: input.relevantFiles?.length ?? 0,
      acceptanceCriteriaCount: input.acceptanceCriteria?.length ?? 0,
      priority: input.priority ?? "normal"
    },
    async () => {
      const { task, reused } = await createCodexTask(config, input);
      const worker = await listWorkerHeartbeats(config);
      return {
        accepted: true,
        task: taskToView(task),
        reused,
        workerOnline: worker.online,
        workerCommand: "npm run --silent codex-worker -- --config <runtime.config.json> --once",
        note: worker.online
          ? "Task queued for the online local Codex worker."
          : "Task queued. Start or keep a local codex-worker process running to execute it.",
        nextAction: {
          tool: "codex_task_status",
          arguments: { taskId: task.id },
          reason: "Query the durable task status after the local worker claims it."
        }
      };
    }
  );
}

export async function codexTaskListTool(
  config: RuntimeConfig,
  input: { status?: CodexTaskStatus; limit?: number } = {}
) {
  return auditToolCall(
    config,
    "codex_task_list",
    {
      status: input.status,
      limit: input.limit
    },
    async () => {
      const tasks = await listCodexTasks(config, input);
      return {
        tasks: tasks.map((task) => taskToView(task)),
        count: tasks.length
      };
    }
  );
}

export async function codexTaskStatusTool(
  config: RuntimeConfig,
  input: { taskId: string; includePrompt?: boolean }
) {
  return auditToolCall(
    config,
    "codex_task_status",
    {
      taskId: input.taskId,
      includePrompt: Boolean(input.includePrompt)
    },
    async () => {
      const task = taskToView(await readCodexTask(config, input.taskId), { includePrompt: input.includePrompt });
      return {
        task,
        nextAction: task.status === "queued" || task.status === "running"
          ? {
            tool: task.status === "running" ? "codex_task_tail" : "codex_task_status",
            arguments: { taskId: task.id },
            reason: task.status === "running"
              ? "Read the worker log while the task runs."
              : "Wait briefly for a worker to claim the queued task, then query again."
          }
          : undefined
      };
    }
  );
}

export async function codexTaskTailTool(
  config: RuntimeConfig,
  input: { taskId: string; offset?: number; bytes?: number }
) {
  return auditToolCall(
    config,
    "codex_task_tail",
    {
      taskId: input.taskId,
      offset: input.offset,
      bytes: input.bytes
    },
    async () => {
      const [log, task] = await Promise.all([
        tailCodexTaskLog(config, input.taskId, input),
        readCodexTask(config, input.taskId)
      ]);
      return {
        ...log,
        status: task.status,
        nextAction: log.truncated || task.status === "running"
          ? {
            tool: "codex_task_tail",
            arguments: { taskId: input.taskId, offset: log.nextOffset, bytes: input.bytes },
            reason: task.status === "running"
              ? "Wait briefly, then continue reading the worker log from the returned offset."
              : "Continue reading the remaining persisted worker log."
          }
          : undefined
      };
    }
  );
}

export async function codexTaskCancelTool(
  config: RuntimeConfig,
  input: { taskId: string; reason?: string }
) {
  return auditToolCall(
    config,
    "codex_task_cancel",
    {
      taskId: input.taskId
    },
    async () => ({
      task: taskToView(await cancelCodexTask(config, input.taskId, input.reason))
    })
  );
}
