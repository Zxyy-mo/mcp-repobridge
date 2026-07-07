import type { RuntimeConfig } from "../config/config.js";

export function buildDockerRunArgs(config: RuntimeConfig): string[] {
  const args = [
    "run",
    "-d",
    "--name", config.sandbox.containerName,
    "--workdir", config.workspace.containerPath,
    "--user", config.sandbox.user,
    "--cap-drop=ALL",
    "--security-opt", "no-new-privileges",
    "--network", config.sandbox.network,
    "--memory", config.sandbox.memory,
    "--cpus", config.sandbox.cpus,
    "--pids-limit", String(config.sandbox.pidsLimit)
  ];

  if (config.sandbox.readOnlyRootfs) {
    args.push("--read-only");
  }

  for (const tmpfs of config.sandbox.tmpfs) {
    args.push("--tmpfs", tmpfs);
  }

  args.push(
    "--mount",
    `type=bind,source=${config.workspace.root},target=${config.workspace.containerPath},${config.workspace.defaultMountMode}`,
    config.sandbox.image,
    "sleep",
    "infinity"
  );

  return args;
}
