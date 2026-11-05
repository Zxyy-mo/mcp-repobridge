import type { RuntimeConfig } from "../config/config.js";
import { auditToolCall } from "../audit/auditLog.js";
import { readFileRange } from "./readFile.js";

export type BatchReadItem = {
  path: string;
  offset?: number;
  limit?: number;
};

export async function readFilesTool(
  config: RuntimeConfig,
  input: { items: BatchReadItem[]; maxTotalBytes?: number }
) {
  return auditToolCall(config, "read_files", {
    itemCount: input.items.length,
    maxTotalBytes: input.maxTotalBytes
  }, async () => {
    if (input.items.length === 0) throw new Error("read_files items cannot be empty");
    if (input.items.length > config.workspace.maxBatchReadItems) {
      throw new Error(`read_files exceeds the ${config.workspace.maxBatchReadItems} item limit`);
    }
    const budgetBytes = Math.min(
      input.maxTotalBytes ?? config.workspace.maxBatchReadBytes,
      config.workspace.maxBatchReadBytes
    );
    let remainingBytes = budgetBytes;
    const results: Array<Record<string, unknown>> = [];
    const continueItems: BatchReadItem[] = [];

    for (const item of input.items) {
      if (remainingBytes <= 0) {
        results.push({
          path: item.path,
          ok: false,
          error: {
            code: "RESULT_BUDGET_EXCEEDED",
            message: "The batch read result budget was exhausted before this item.",
            retryable: true
          }
        });
        continueItems.push(item);
        continue;
      }
      try {
        const requestedLimit = Math.min(item.limit ?? config.workspace.maxReadBytes, remainingBytes);
        const result = await readFileRange(config, { ...item, limit: requestedLimit });
        remainingBytes -= result.bytesRead;
        results.push({ ok: true, ...result });
        if (result.nextOffset !== undefined) {
          continueItems.push({ path: item.path, offset: result.nextOffset, limit: item.limit });
        }
      } catch (error) {
        results.push({
          path: item.path,
          ok: false,
          error: {
            code: errorCode(error),
            message: error instanceof Error ? error.message : String(error),
            retryable: false
          }
        });
      }
    }

    return {
      results,
      totalBytes: budgetBytes - remainingBytes,
      budgetBytes,
      truncated: continueItems.length > 0,
      nextAction: continueItems.length > 0
        ? {
          tool: "read_files",
          arguments: { items: continueItems, maxTotalBytes: budgetBytes },
          reason: "Continue the files that were truncated or deferred by the batch result budget."
        }
        : undefined
    };
  }, (result) => ({ stdoutBytes: result.totalBytes }));
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/blocked|escapes|symlink/i.test(message)) return "POLICY_DENIED";
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "NOT_FOUND";
  return "READ_FAILED";
}
