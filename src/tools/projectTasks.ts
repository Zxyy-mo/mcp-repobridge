import type { RuntimeConfig } from "../config/config.js";
import { auditToolCall } from "../audit/auditLog.js";
import { PolicyError } from "../policy/errors.js";
import { discoverProjectTasks, findProjectTask, parseProjectDiagnostics } from "../project/projectTasks.js";
import { execContainerTool } from "./execContainer.js";

export async function projectTaskListTool(config: RuntimeConfig) {
  return auditToolCall(config, "project_task_list", {}, async () => {
    const tasks = await discoverProjectTasks(config.workspace.root);
    return { tasks, count: tasks.length };
  });
}

export async function projectTaskRunTool(
  config: RuntimeConfig,
  input: { name: string; timeoutMs?: number; yieldMs?: number }
) {
  return auditToolCall(config, "project_task_run", {
    name: input.name,
    timeoutMs: input.timeoutMs,
    yieldMs: input.yieldMs
  }, async () => {
    const task = await findProjectTask(config.workspace.root, input.name);
    if (!task) throw new PolicyError(`Unknown or unsafe project task: ${input.name}`);
    const result = await execContainerTool(config, {
      command: task.command,
      timeoutMs: input.timeoutMs,
      yieldMs: input.yieldMs,
      projectTask: { name: task.name, kind: task.kind, source: task.source }
    });
    const stdout = "stdout" in result ? result.stdout : "";
    const stderr = "stderr" in result ? result.stderr : "";
    return {
      ...result,
      projectTask: task,
      diagnostics: parseProjectDiagnostics(`${stdout}\n${stderr}`)
    };
  });
}
