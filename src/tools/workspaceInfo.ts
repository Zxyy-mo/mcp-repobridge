import type { RuntimeConfig } from "../config/config.js";
import { auditToolCall } from "../audit/auditLog.js";

export async function workspaceInfoTool(config: RuntimeConfig) {
  return auditToolCall(config, "workspace_info", {}, async () => ({
    workspaceRoot: config.workspace.root,
    containerPath: config.workspace.containerPath,
    defaultMountMode: config.workspace.defaultMountMode,
    maxReadBytes: config.workspace.maxReadBytes,
    maxDirectoryEntries: config.workspace.maxDirectoryEntries,
    sandbox: {
      containerName: config.sandbox.containerName,
      image: config.sandbox.image,
      network: config.sandbox.network,
      memory: config.sandbox.memory,
      cpus: config.sandbox.cpus,
      pidsLimit: config.sandbox.pidsLimit,
      user: config.sandbox.user,
      readOnlyRootfs: config.sandbox.readOnlyRootfs
    },
    policy: {
      allowExec: config.policy.allowExec,
      execMode: config.policy.execMode,
      denyNetworkCommands: config.policy.denyNetworkCommands,
      denyDockerInsideContainer: config.policy.denyDockerInsideContainer,
      denySecretsRead: config.policy.denySecretsRead
    },
    auditEnabled: config.audit.enabled,
    codexHandoff: {
      enabled: config.codexHandoff.enabled,
      queuePath: config.codexHandoff.queuePath,
      maxPromptBytes: config.codexHandoff.maxPromptBytes,
      maxResultBytes: config.codexHandoff.maxResultBytes,
      maxTasksListed: config.codexHandoff.maxTasksListed,
      taskTimeoutMs: config.codexHandoff.taskTimeoutMs,
      workerPollIntervalMs: config.codexHandoff.workerPollIntervalMs,
      codexCommand: config.codexHandoff.codexCommand,
      codexArgs: config.codexHandoff.codexArgs
    }
  }));
}
