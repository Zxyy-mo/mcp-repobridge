import fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import type { RuntimeConfig } from "../config/config.js";
import { auditToolCall } from "../audit/auditLog.js";
import { assertNotSecretLike, resolveWorkspacePath } from "../policy/pathPolicy.js";

export async function readFileTool(config: RuntimeConfig, input: { path: string; offset?: number; limit?: number }) {
  return auditToolCall(config, "read_file", {
    path: input.path,
    offset: input.offset ?? 0,
    limit: input.limit ?? config.workspace.maxReadBytes
  }, async () => readFileRange(config, input), (result) => ({
    stdoutBytes: result.bytesRead
  }));
}

export async function readFileRange(
  config: RuntimeConfig,
  input: { path: string; offset?: number; limit?: number }
) {
  const target = await resolveWorkspacePath(config.workspace.root, input.path);
  if (config.policy.denySecretsRead) {
    assertNotSecretLike(config.workspace.root, target);
  }
  const offset = input.offset ?? 0;
  if (offset < 0) {
    throw new Error("offset must be non-negative");
  }
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error("read_file target must be a file");
    }
    const max = Math.min(input.limit ?? config.workspace.maxReadBytes, config.workspace.maxReadBytes);
    const bytesToRead = Math.max(0, Math.min(max, stat.size - offset));
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, offset);
    let sha256: string | undefined;
    if (stat.size <= config.workspace.maxHashBytes) {
      const hash = createHash("sha256");
      const hashBuffer = Buffer.allocUnsafe(64 * 1024);
      let hashOffset = 0;
      while (hashOffset < stat.size) {
        const requested = Math.min(hashBuffer.length, stat.size - hashOffset);
        const hashed = await handle.read(hashBuffer, 0, requested, hashOffset);
        if (hashed.bytesRead === 0) break;
        hash.update(hashBuffer.subarray(0, hashed.bytesRead));
        hashOffset += hashed.bytesRead;
      }
      sha256 = hash.digest("hex");
    }
    const nextOffset = offset + bytesRead;
    return {
      path: input.path,
      content: buffer.subarray(0, bytesRead).toString("utf8"),
      encoding: "utf-8" as const,
      offset,
      nextOffset: nextOffset < stat.size ? nextOffset : undefined,
      totalBytes: stat.size,
      truncated: nextOffset < stat.size,
      bytesRead,
      sha256,
      hashStatus: sha256 ? "complete" as const : "skipped_size_limit" as const
    };
  } finally {
    await handle.close();
  }
}
