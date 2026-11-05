import type { RuntimeConfig } from "../config/config.js";
import { spawnLimited } from "../utils/childProcess.js";
import { buildDockerRunArgs } from "./dockerArgs.js";
import {
  isManagedWorkspaceSnapshot,
  prepareWorkspaceSnapshot,
  removeWorkspaceSnapshot,
  type WorkspaceSnapshotSummary
} from "./workspaceSnapshot.js";

export type SandboxStartResult = Awaited<ReturnType<typeof spawnLimited>> & {
  snapshot?: WorkspaceSnapshotSummary;
  alreadyRunning?: boolean;
};

export type SandboxInspection = {
  exists: boolean;
  running: boolean;
  status?: string;
  image?: string;
  managed: boolean;
  workspaceSource?: string;
  error?: string;
};

export async function startSandbox(config: RuntimeConfig): Promise<SandboxStartResult> {
  const current = await inspectSandboxState(config);
  if (current.exists && !current.managed) {
    return unmanagedContainerResult(config.sandbox.containerName);
  }
  if (current.running) {
    return {
      code: 0,
      signal: null,
      stdout: "Sandbox is already running.\n",
      stderr: "",
      timedOut: false,
      truncated: false,
      alreadyRunning: true
    };
  }
  if (current.exists) {
    const removed = await stopSandbox(config);
    if (removed.code !== 0) return removed;
  } else if (current.error && !/no such (object|container)/i.test(current.error)) {
    return {
      code: 1,
      signal: null,
      stdout: "",
      stderr: current.error,
      timedOut: false,
      truncated: false
    };
  }
  const snapshot = await prepareWorkspaceSnapshot(config);
  try {
    const result = await spawnLimited("docker", buildDockerRunArgs(config, snapshot.workspacePath), {
      timeoutMs: 30000,
      maxOutputBytes: 20000
    });
    if (result.code !== 0) {
      await removeWorkspaceSnapshot(snapshot.workspacePath);
      return result;
    }
    return { ...result, snapshot: snapshot.summary };
  } catch (error) {
    await removeWorkspaceSnapshot(snapshot.workspacePath).catch(() => undefined);
    throw error;
  }
}

export async function stopSandbox(config: RuntimeConfig) {
  const current = await inspectSandboxState(config);
  if (current.exists && !current.managed) {
    return unmanagedContainerResult(config.sandbox.containerName);
  }
  const snapshotWorkspacePath = current.workspaceSource && await isManagedWorkspaceSnapshot(current.workspaceSource)
    ? current.workspaceSource
    : undefined;
  if (!current.exists && current.error && /no such (object|container)/i.test(current.error)) {
    return {
      code: 0,
      signal: null,
      stdout: "Sandbox is already stopped.\n",
      stderr: "",
      timedOut: false,
      truncated: false
    };
  }
  const result = await spawnLimited("docker", ["rm", "-f", config.sandbox.containerName], {
    timeoutMs: 30000,
    maxOutputBytes: 20000
  });
  if (result.code === 0 && snapshotWorkspacePath) {
    await removeWorkspaceSnapshot(snapshotWorkspacePath);
  }
  return result;
}

export async function inspectSandbox(config: RuntimeConfig) {
  return spawnLimited("docker", ["inspect", config.sandbox.containerName], {
    timeoutMs: 30000,
    maxOutputBytes: 100000
  });
}

export async function inspectSandboxState(config: RuntimeConfig): Promise<SandboxInspection> {
  try {
    const result = await inspectSandbox(config);
    if (result.code !== 0) {
      return {
        exists: false,
        running: false,
        managed: false,
        error: result.stderr || result.stdout
      };
    }
    const [container] = JSON.parse(result.stdout) as Array<{
      State?: { Running?: boolean; Status?: string };
      Config?: { Image?: string; Labels?: Record<string, string> };
      Mounts?: Array<{ Destination?: string; Source?: string }>;
    }>;
    const workspaceSource = container?.Mounts?.find(
      (mount) => mount.Destination === config.workspace.containerPath
    )?.Source;
    return {
      exists: true,
      running: container?.State?.Running === true,
      status: container?.State?.Status,
      image: container?.Config?.Image,
      managed: container?.Config?.Labels?.["mcp-repobridge.managed"] === "true",
      workspaceSource
    };
  } catch (error) {
    return {
      exists: false,
      running: false,
      managed: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function unmanagedContainerResult(containerName: string) {
  return {
    code: 1,
    signal: null,
    stdout: "",
    stderr: `Refusing to use or remove unmanaged container with configured name: ${containerName}`,
    timedOut: false,
    truncated: false
  };
}
