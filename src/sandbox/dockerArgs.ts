import type { RuntimeConfig } from "../config/config.js";

export function buildDockerRunArgs(config: RuntimeConfig, snapshotWorkspacePath: string): string[] {
  const args = [
    "run",
    "-d",
    "--name", config.sandbox.containerName,
    "--label", "mcp-repobridge.managed=true",
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
    `type=bind,source=${snapshotWorkspacePath},target=${config.workspace.containerPath},rw`,
    config.sandbox.image,
    "sleep",
    "infinity"
  );

  return args;
}
