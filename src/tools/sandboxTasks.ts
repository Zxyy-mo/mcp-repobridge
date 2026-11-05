import type { RuntimeConfig } from "../config/config.js";
import { auditToolCall } from "../audit/auditLog.js";
import { cancelSandboxTask, sandboxTaskStatus, sandboxTaskTail } from "../sandbox/taskRunner.js";
import { parseProjectDiagnostics } from "../project/projectTasks.js";

export async function sandboxTaskStatusTool(config: RuntimeConfig, input: { taskId: string }) {
  return auditToolCall(config, "sandbox_task_status", { taskId: input.taskId }, () => (
    sandboxTaskStatus(config, input.taskId)
  ));
}

export async function sandboxTaskTailTool(
  config: RuntimeConfig,
  input: { taskId: string; stdoutOffset?: number; stderrOffset?: number; maxBytes?: number }
) {
  return auditToolCall(config, "sandbox_task_tail", {
    taskId: input.taskId,
    stdoutOffset: input.stdoutOffset,
    stderrOffset: input.stderrOffset,
    maxBytes: input.maxBytes
  }, async () => {
    const result = await sandboxTaskTail(config, input);
    return {
      ...result,
      diagnostics: parseProjectDiagnostics(`${result.stdout.content}\n${result.stderr.content}`)
    };
  }, (result) => ({
    stdoutBytes: Buffer.byteLength(result.stdout.content),
    stderrBytes: Buffer.byteLength(result.stderr.content)
  }));
}

export async function sandboxTaskCancelTool(
  config: RuntimeConfig,
  input: { taskId: string; reason?: string }
) {
  return auditToolCall(config, "sandbox_task_cancel", { taskId: input.taskId }, () => (
    cancelSandboxTask(config, input.taskId, input.reason)
  ));
}
