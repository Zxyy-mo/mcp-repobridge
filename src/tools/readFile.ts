import fs from "node:fs/promises";
import type { RuntimeConfig } from "../config/config.js";
import { auditToolCall } from "../audit/auditLog.js";
import { assertNotSecretLike, resolveWorkspacePath } from "../policy/pathPolicy.js";

export async function readFileTool(config: RuntimeConfig, input: { path: string; offset?: number; limit?: number }) {
  return auditToolCall(config, "read_file", {
    path: input.path,
    offset: input.offset ?? 0,
    limit: input.limit ?? config.workspace.maxReadBytes
  }, async () => {
    const target = await resolveWorkspacePath(config.workspace.root, input.path);
    if (config.policy.denySecretsRead) {
      assertNotSecretLike(config.workspace.root, target);
    }
    const stat = await fs.stat(target);
    if (!stat.isFile()) {
      throw new Error("read_file target must be a file");
    }
    const offset = input.offset ?? 0;
    if (offset < 0) {
      throw new Error("offset must be non-negative");
    }
    const max = Math.min(input.limit ?? config.workspace.maxReadBytes, config.workspace.maxReadBytes);
    const bytesToRead = Math.max(0, Math.min(max, stat.size - offset));
    const buffer = Buffer.alloc(bytesToRead);
    const handle = await fs.open(target, "r");
    try {
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, offset);
      const content = buffer.subarray(0, bytesRead).toString("utf8");
      return {
        path: input.path,
        content,
        truncated: offset + bytesRead < stat.size,
        bytesRead
      };
    } finally {
      await handle.close();
    }
  }, (result) => ({
    stdoutBytes: result.bytesRead
  }));
}
