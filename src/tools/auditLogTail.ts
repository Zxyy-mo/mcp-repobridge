import fs from "node:fs/promises";
import path from "node:path";
import type { RuntimeConfig } from "../config/config.js";
import { auditToolCall } from "../audit/auditLog.js";

export async function auditLogTailTool(config: RuntimeConfig, input: { lines?: number }) {
  const requestedLines = input.lines ?? 50;
  const lines = Math.min(Math.max(requestedLines, 1), 200);
  return auditToolCall(config, "audit_log_tail", { lines }, async () => {
    const auditPath = path.resolve(config.workspace.root, config.audit.path);
    try {
      const text = await fs.readFile(auditPath, "utf8");
      const records = text.trimEnd().split(/\r?\n/).filter(Boolean).slice(-lines).map((line) => {
        try {
          return JSON.parse(line) as unknown;
        } catch {
          return { parseError: true, raw: line.slice(0, 500) };
        }
      });
      return {
        path: config.audit.path,
        records,
        truncated: text.trimEnd().split(/\r?\n/).filter(Boolean).length > records.length
      };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        return {
          path: config.audit.path,
          records: [],
          truncated: false
        };
      }
      throw error;
    }
  }, (result) => ({
    stdoutBytes: Buffer.byteLength(JSON.stringify(result.records))
  }));
}
