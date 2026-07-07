import path from "node:path/posix";
import type { RuntimeConfig } from "../config/config.js";
import { validateCommand } from "../policy/commandPolicy.js";
import { spawnLimited } from "../utils/childProcess.js";
import { writeAudit } from "../audit/auditLog.js";

export async function execContainerTool(
  config: RuntimeConfig,
  input: { command: string; workdir?: string; timeoutMs?: number }
) {
  if (!config.policy.allowExec) {
    throw new Error("exec_container is disabled by policy");
  }

  const started = Date.now();
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

    const result = await spawnLimited("docker", [
      "exec",
      "-i",
      "--workdir",
      safeWorkdir,
      config.sandbox.containerName,
      "bash",
      "-lc",
      input.command
    ], {
      timeoutMs,
      maxOutputBytes: config.sandbox.maxOutputBytes,
      env: { PATH: process.env.PATH ?? "" }
    });

    await writeAudit(config, {
      timestamp: new Date().toISOString(),
      tool: "exec_container",
      action: "allow",
      summary: { commandPreview: input.command.slice(0, 120), workdir: safeWorkdir },
      durationMs: Date.now() - started,
      exitCode: result.code,
      stdoutBytes: Buffer.byteLength(result.stdout),
      stderrBytes: Buffer.byteLength(result.stderr)
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
