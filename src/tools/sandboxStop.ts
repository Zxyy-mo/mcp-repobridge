import type { RuntimeConfig } from "../config/config.js";
import { writeAudit } from "../audit/auditLog.js";
import { stopSandbox } from "../sandbox/dockerClient.js";

export async function sandboxStopTool(config: RuntimeConfig) {
  const started = Date.now();
  try {
    const result = await stopSandbox(config);
    await writeAudit(config, {
      timestamp: new Date().toISOString(),
      tool: "sandbox_stop",
      action: result.code === 0 ? "allow" : "deny",
      summary: { containerName: config.sandbox.containerName },
      durationMs: Date.now() - started,
      exitCode: result.code,
      stdoutBytes: Buffer.byteLength(result.stdout),
      stderrBytes: Buffer.byteLength(result.stderr)
    });
    return result;
  } catch (error) {
    await writeAudit(config, {
      timestamp: new Date().toISOString(),
      tool: "sandbox_stop",
      action: "deny",
      summary: {
        containerName: config.sandbox.containerName,
        reason: error instanceof Error ? error.message : String(error)
      },
      durationMs: Date.now() - started
    });
    throw error;
  }
}
