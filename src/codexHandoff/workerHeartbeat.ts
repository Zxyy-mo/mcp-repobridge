import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import type { RuntimeConfig } from "../config/config.js";
import { ensureHandoffEnabled, ensureQueuePaths } from "./taskStore.js";

export type WorkerHeartbeat = {
  schemaVersion: 1;
  workerId: string;
  pid?: number;
  status: "idle" | "running";
  taskId?: string;
  startedAt: string;
  lastSeenAt: string;
};

const workerStartedAt = new Map<string, string>();

export async function writeWorkerHeartbeat(
  config: RuntimeConfig,
  input: { workerId: string; pid?: number; status: "idle" | "running"; taskId?: string }
): Promise<WorkerHeartbeat> {
  ensureHandoffEnabled(config);
  if (!input.workerId.trim() || Buffer.byteLength(input.workerId, "utf8") > 300) {
    throw new Error("Codex worker id must be between 1 and 300 bytes");
  }
  const { heartbeatsDir } = await ensureQueuePaths(config);
  const now = new Date().toISOString();
  const heartbeat: WorkerHeartbeat = {
    schemaVersion: 1,
    workerId: input.workerId,
    pid: input.pid,
    status: input.status,
    taskId: input.taskId,
    startedAt: workerStartedAt.get(input.workerId) ?? now,
    lastSeenAt: now
  };
  workerStartedAt.set(input.workerId, heartbeat.startedAt);
  const destination = path.join(heartbeatsDir, `${workerFileId(input.workerId)}.json`);
  const temporary = path.join(heartbeatsDir, `.${workerFileId(input.workerId)}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(heartbeat)}\n`, { mode: 0o600 });
  await fs.rename(temporary, destination);
  return heartbeat;
}

export async function listWorkerHeartbeats(config: RuntimeConfig): Promise<{
  online: boolean;
  workers: Array<WorkerHeartbeat & { online: boolean }>;
}> {
  ensureHandoffEnabled(config);
  const { heartbeatsDir } = await ensureQueuePaths(config);
  const entries = await fs.readdir(heartbeatsDir);
  const now = Date.now();
  const workers: Array<WorkerHeartbeat & { online: boolean }> = [];
  for (const entry of entries.filter((name) => name.endsWith(".json")).sort()) {
    try {
      const handle = await fs.open(path.join(heartbeatsDir, entry), constants.O_RDONLY | constants.O_NOFOLLOW);
      let heartbeat: WorkerHeartbeat;
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) continue;
        heartbeat = JSON.parse(await handle.readFile("utf8")) as WorkerHeartbeat;
      } finally {
        await handle.close();
      }
      if (
        heartbeat.schemaVersion !== 1 ||
        !heartbeat.workerId ||
        !heartbeat.lastSeenAt ||
        !heartbeat.startedAt ||
        (heartbeat.status !== "idle" && heartbeat.status !== "running")
      ) continue;
      workers.push({
        schemaVersion: 1,
        workerId: heartbeat.workerId,
        pid: typeof heartbeat.pid === "number" ? heartbeat.pid : undefined,
        status: heartbeat.status,
        taskId: typeof heartbeat.taskId === "string" ? heartbeat.taskId : undefined,
        startedAt: heartbeat.startedAt,
        lastSeenAt: heartbeat.lastSeenAt,
        online: now - Date.parse(heartbeat.lastSeenAt) <= config.codexHandoff.workerHeartbeatTtlMs
      });
    } catch {
      // Ignore partial or invalid heartbeat files; the next worker tick replaces them atomically.
    }
  }
  workers.sort((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt));
  return { online: workers.some((worker) => worker.online), workers };
}

function workerFileId(workerId: string): string {
  return createHash("sha256").update(workerId).digest("hex").slice(0, 24);
}
