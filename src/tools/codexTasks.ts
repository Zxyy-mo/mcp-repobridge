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

export async function codexTaskCreateTool(
  config: RuntimeConfig,
  input: {
    title: string;
    prompt: string;
    acceptanceCriteria?: string[];
    relevantFiles?: string[];
    priority?: CodexTaskPriority;
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
      const task = await createCodexTask(config, input);
      return {
        task: taskToView(task),
        workerCommand: "npm run --silent codex-worker -- --config <runtime.config.json> --once",
        note: "Task queued. Start or keep a local codex-worker process running to execute it."
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
    async () => ({
      task: taskToView(await readCodexTask(config, input.taskId), { includePrompt: input.includePrompt })
    })
  );
}

export async function codexTaskTailTool(
  config: RuntimeConfig,
  input: { taskId: string; bytes?: number }
) {
  return auditToolCall(
    config,
    "codex_task_tail",
    {
      taskId: input.taskId,
      bytes: input.bytes
    },
    async () => tailCodexTaskLog(config, input.taskId, input.bytes)
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
