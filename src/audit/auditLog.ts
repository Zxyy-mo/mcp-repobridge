import fs from "node:fs/promises";
import path from "node:path";
import type { RuntimeConfig } from "../config/config.js";

export type AuditRecord = {
  timestamp: string;
  tool: string;
  action: "allow" | "deny";
  summary: Record<string, unknown>;
  durationMs?: number;
  exitCode?: number | null;
  stdoutBytes?: number;
  stderrBytes?: number;
};

export async function writeAudit(config: RuntimeConfig, record: AuditRecord): Promise<void> {
  if (!config.audit.enabled) return;
  const auditPath = path.resolve(config.workspace.root, config.audit.path);
  await fs.mkdir(path.dirname(auditPath), { recursive: true });
  await fs.appendFile(auditPath, JSON.stringify(record) + "\n", "utf8");
}

export async function auditToolCall<T>(
  config: RuntimeConfig,
  tool: string,
  summary: Record<string, unknown>,
  call: () => Promise<T>,
  metrics?: (result: T) => Partial<AuditRecord>
): Promise<T> {
  const started = Date.now();
  try {
    const result = await call();
    await writeAudit(config, {
      timestamp: new Date().toISOString(),
      tool,
      action: "allow",
      summary,
      durationMs: Date.now() - started,
      ...metrics?.(result)
    });
    return result;
  } catch (error) {
    await writeAudit(config, {
      timestamp: new Date().toISOString(),
      tool,
      action: "deny",
      summary: {
        ...summary,
        reason: error instanceof Error ? error.message : String(error)
      },
      durationMs: Date.now() - started
    });
    throw error;
  }
}
