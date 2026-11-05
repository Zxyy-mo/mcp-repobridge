import type { RuntimeConfig } from "../config/config.js";
import { writeAudit } from "../audit/auditLog.js";
import { inspectSandboxState } from "../sandbox/dockerClient.js";

export async function sandboxStatusTool(config: RuntimeConfig) {
  const started = Date.now();
  try {
    const state = await inspectSandboxState(config);
    const { workspaceSource: _workspaceSource, ...publicState } = state;
    await writeAudit(config, {
      timestamp: new Date().toISOString(),
      tool: "sandbox_status",
      action: "allow",
      summary: { containerName: config.sandbox.containerName },
      durationMs: Date.now() - started,
      exitCode: state.error ? 1 : 0,
      stdoutBytes: 0,
      stderrBytes: Buffer.byteLength(state.error ?? "")
    });
    return {
      ...publicState,
      ready: state.running && state.managed,
      workspaceMode: "filtered-ephemeral-copy",
      error: state.error?.slice(0, 2000)
    };
  } catch (error) {
    await writeAudit(config, {
      timestamp: new Date().toISOString(),
      tool: "sandbox_status",
      action: "allow",
      summary: {
        containerName: config.sandbox.containerName,
        error: error instanceof Error ? error.message : String(error)
      },
      durationMs: Date.now() - started
    });
    return {
      running: false,
      exists: false,
      managed: false,
      ready: false,
      workspaceMode: "filtered-ephemeral-copy",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
