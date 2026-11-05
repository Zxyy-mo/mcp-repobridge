import path from "node:path/posix";
import type { RuntimeConfig } from "../config/config.js";
import { validateCommand } from "../policy/commandPolicy.js";
import { PolicyError } from "../policy/errors.js";
import { writeAudit } from "../audit/auditLog.js";
import { inspectSandboxState, startSandbox } from "../sandbox/dockerClient.js";
import { runSandboxCommand } from "../sandbox/taskRunner.js";

export async function execContainerTool(
  config: RuntimeConfig,
  input: {
    command: string;
    workdir?: string;
    timeoutMs?: number;
    yieldMs?: number;
    projectTask?: { name: string; kind: string; source: string };
  }
) {
  if (!config.policy.allowExec) {
    throw new PolicyError("exec_container is disabled by policy");
  }

  const started = Date.now();
  let autoStarted = false;
  try {
    validateCommand(input.command, {
      mode: config.policy.execMode,
      allowedCommands: config.policy.allowedCommands
    });
    const safeWorkdir = resolveContainerWorkdir(config.workspace.containerPath, input.workdir);
    if (input.timeoutMs !== undefined && input.timeoutMs <= 0) {
      throw new Error("timeoutMs must be positive");
    }
    const timeoutMs = Math.min(input.timeoutMs ?? config.sandbox.timeoutMs, config.sandbox.timeoutMs);

    const state = await inspectSandboxState(config);
    if (state.exists && !state.managed) {
      throw new Error(`Refusing to execute in unmanaged container: ${config.sandbox.containerName}`);
    }
    if (config.sandbox.startMode === "on-demand") {
      if (!state.running) {
        const sandboxStart = await startSandbox(config);
        if (sandboxStart.code !== 0) {
          throw new Error(sandboxStart.stderr || sandboxStart.stdout || "Failed to start Docker sandbox");
        }
        autoStarted = true;
      }
    }

    const result = await runSandboxCommand(config, {
      command: input.command,
      workdir: safeWorkdir,
      timeoutMs,
      yieldMs: input.yieldMs,
      projectTask: input.projectTask
    });
    const exitCode = "code" in result ? result.code : undefined;
    const stdout = "stdout" in result ? result.stdout : "";
    const stderr = "stderr" in result ? result.stderr : "";

    await writeAudit(config, {
      timestamp: new Date().toISOString(),
      tool: "exec_container",
      action: "allow",
      summary: { commandPreview: input.command.slice(0, 120), workdir: safeWorkdir, autoStarted },
      durationMs: Date.now() - started,
      exitCode,
      stdoutBytes: Buffer.byteLength(stdout),
      stderrBytes: Buffer.byteLength(stderr)
    });

    return result;
  } catch (error) {
    await writeAudit(config, {
      timestamp: new Date().toISOString(),
      tool: "exec_container",
      action: "deny",
      summary: { commandPreview: input.command.slice(0, 120), reason: String(error) },
      durationMs: Date.now() - started
    });
    throw error;
  }
}

export function resolveContainerWorkdir(containerRoot: string, requested?: string): string {
  if (!requested || requested === ".") return containerRoot;
  const candidate = requested.startsWith("/")
    ? path.normalize(requested)
    : path.normalize(path.join(containerRoot, requested));
  const relative = path.relative(containerRoot, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Container workdir escapes workspace");
  }
  return candidate;
}
