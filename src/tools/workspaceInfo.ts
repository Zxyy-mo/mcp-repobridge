import type { RuntimeConfig } from "../config/config.js";
import { auditToolCall } from "../audit/auditLog.js";

export async function workspaceInfoTool(config: RuntimeConfig) {
  return auditToolCall(config, "workspace_info", {}, async () => ({
    server: {
      transport: config.server.transport,
      allowedOrigins: config.server.allowedOrigins,
      allowedHosts: config.server.allowedHosts,
      maxSessions: config.server.maxSessions,
      sessionTtlMs: config.server.sessionTtlMs
    },
    workspaceRoot: config.workspace.root,
    containerPath: config.workspace.containerPath,
    sandboxWorkspaceMode: "filtered-ephemeral-copy",
    defaultMountMode: config.workspace.defaultMountMode,
    maxReadBytes: config.workspace.maxReadBytes,
    maxHashBytes: config.workspace.maxHashBytes,
    maxBatchReadBytes: config.workspace.maxBatchReadBytes,
    maxBatchReadItems: config.workspace.maxBatchReadItems,
    maxDirectoryEntries: config.workspace.maxDirectoryEntries,
    sandbox: {
      containerName: config.sandbox.containerName,
      image: config.sandbox.image,
      startMode: config.sandbox.startMode,
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
    extensions: {
      enabled: config.extensions.enabled,
      hostMcpEnabled: config.extensions.hostMcpEnabled,
      skillDirsConfigured: config.extensions.skillDirs.length,
      maxSkills: config.extensions.maxSkills,
      maxSkillBytes: config.extensions.maxSkillBytes,
      discoveryTtlMs: config.extensions.discoveryTtlMs,
      connectTimeoutMs: config.extensions.connectTimeoutMs,
      callTimeoutMs: config.extensions.callTimeoutMs,
      maxResultBytes: config.extensions.maxResultBytes,
      maxToolsPerServer: config.extensions.maxToolsPerServer,
      maxConcurrentMcpProcesses: config.extensions.maxConcurrentMcpProcesses,
      mcpServers: config.extensions.mcpServers
        .filter((server) => server.enabled)
        .map((server) => ({
          name: server.name,
          description: server.description,
          allowedTools: server.allowedTools.length,
          mappedEnvironmentVariableCount: Object.keys(server.envFromHost).length
        }))
    },
    codexHandoff: {
      enabled: config.codexHandoff.enabled,
      queuePath: config.codexHandoff.queuePath,
      maxPromptBytes: config.codexHandoff.maxPromptBytes,
      maxResultBytes: config.codexHandoff.maxResultBytes,
      maxTasksListed: config.codexHandoff.maxTasksListed,
      taskTimeoutMs: config.codexHandoff.taskTimeoutMs,
      workerPollIntervalMs: config.codexHandoff.workerPollIntervalMs,
      workerHeartbeatIntervalMs: config.codexHandoff.workerHeartbeatIntervalMs,
      workerHeartbeatTtlMs: config.codexHandoff.workerHeartbeatTtlMs,
      cancellationPollIntervalMs: config.codexHandoff.cancellationPollIntervalMs,
      cancellationGraceMs: config.codexHandoff.cancellationGraceMs,
      failOnContextDrift: config.codexHandoff.failOnContextDrift,
      codexCommand: config.codexHandoff.codexCommand,
      codexArgs: config.codexHandoff.codexArgs,
      allowedEnvKeys: config.codexHandoff.allowedEnvKeys,
      allowedEnvPrefixes: config.codexHandoff.allowedEnvPrefixes
    }
  }));
}
