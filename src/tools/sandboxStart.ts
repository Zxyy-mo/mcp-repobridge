import type { RuntimeConfig } from "../config/config.js";
import { writeAudit } from "../audit/auditLog.js";
import { startSandbox } from "../sandbox/dockerClient.js";

export async function sandboxStartTool(config: RuntimeConfig) {
  const started = Date.now();
  try {
    const result = await startSandbox(config);
    await writeAudit(config, {
      timestamp: new Date().toISOString(),
      tool: "sandbox_start",
      action: result.code === 0 ? "allow" : "deny",
      summary: {
        containerName: config.sandbox.containerName,
        image: config.sandbox.image,
        network: config.sandbox.network,
        mountMode: config.workspace.defaultMountMode
      },
      durationMs: Date.now() - started,
      exitCode: result.code,
      stdoutBytes: Buffer.byteLength(result.stdout),
      stderrBytes: Buffer.byteLength(result.stderr)
    });
    return result;
  } catch (error) {
    await writeAudit(config, {
      timestamp: new Date().toISOString(),
      tool: "sandbox_start",
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
