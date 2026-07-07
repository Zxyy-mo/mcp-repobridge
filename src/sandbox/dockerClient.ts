import type { RuntimeConfig } from "../config/config.js";
import { spawnLimited } from "../utils/childProcess.js";
import { buildDockerRunArgs } from "./dockerArgs.js";

export async function startSandbox(config: RuntimeConfig) {
  return spawnLimited("docker", buildDockerRunArgs(config), {
    timeoutMs: 30000,
    maxOutputBytes: 20000
  });
}

export async function stopSandbox(config: RuntimeConfig) {
  return spawnLimited("docker", ["rm", "-f", config.sandbox.containerName], {
    timeoutMs: 30000,
    maxOutputBytes: 20000
  });
}

export async function inspectSandbox(config: RuntimeConfig) {
  return spawnLimited("docker", ["inspect", config.sandbox.containerName], {
    timeoutMs: 30000,
    maxOutputBytes: 100000
  });
}
