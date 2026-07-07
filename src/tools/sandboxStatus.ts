import type { RuntimeConfig } from "../config/config.js";
import { writeAudit } from "../audit/auditLog.js";
import { inspectSandbox } from "../sandbox/dockerClient.js";

export async function sandboxStatusTool(config: RuntimeConfig) {
  const started = Date.now();
  try {
    const result = await inspectSandbox(config);
    await writeAudit(config, {
      timestamp: new Date().toISOString(),
      tool: "sandbox_status",
      action: "allow",
      summary: { containerName: config.sandbox.containerName },
      durationMs: Date.now() - started,
      exitCode: result.code,
      stdoutBytes: Buffer.byteLength(result.stdout),
      stderrBytes: Buffer.byteLength(result.stderr)
    });
    return {
      running: result.code === 0,
      raw: result.stdout.slice(0, 2000),
      error: result.code === 0 ? undefined : result.stderr.slice(0, 2000)
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
      raw: "",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
