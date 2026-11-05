import type { RuntimeConfig } from "../src/config/config.js";

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export function testConfig(root: string, overrides: DeepPartial<RuntimeConfig> = {}): RuntimeConfig {
  const config: RuntimeConfig = {
    server: {
      host: "127.0.0.1",
      port: 8765,
      transport: "stdio",
      authTokenEnv: "SECURE_MCP_TOKEN",
      allowedOrigins: ["https://chatgpt.com", "https://chat.openai.com"],
      allowedHosts: ["127.0.0.1", "localhost", "*.trycloudflare.com"],
      maxSessions: 100,
      sessionTtlMs: 1800000
    },
    workspace: {
      root,
      containerPath: "/workspace",
      defaultMountMode: "ro",
      maxReadBytes: 1024,
      maxHashBytes: 16384,
      maxBatchReadBytes: 4096,
      maxBatchReadItems: 20,
      maxDirectoryEntries: 100
    },
    sandbox: {
      containerName: "secure-mcp-sandbox-test",
      image: "secure-mcp-sandbox:test",
      startMode: "manual",
      network: "none",
      memory: "512m",
      cpus: "1",
      pidsLimit: 64,
      user: "1000:1000",
      readOnlyRootfs: true,
      tmpfs: ["/tmp:rw,nosuid,nodev,size=64m"],
      timeoutMs: 1000,
      maxOutputBytes: 4096,
      taskPath: ".secure-mcp/sandbox-tasks",
      commandYieldMs: 100,
      maxTaskLogBytes: 16384,
      taskCancelGraceMs: 100
    },
    policy: {
      allowExec: true,
      execMode: "denylist",
      denyNetworkCommands: true,
      denyDockerInsideContainer: true,
      denySecretsRead: true
    },
    audit: {
      enabled: true,
      path: ".secure-mcp/audit.log"
    },
    extensions: {
      enabled: false,
      hostMcpEnabled: false,
      skillDirs: [],
      maxSkills: 100,
      maxSkillBytes: 131072,
      discoveryTtlMs: 300000,
      connectTimeoutMs: 1000,
      callTimeoutMs: 1000,
      maxResultBytes: 16384,
      maxToolsPerServer: 100,
      maxConcurrentMcpProcesses: 4,
      safeEnvKeys: ["PATH", "HOME", "USER", "USERNAME", "LANG", "LC_ALL", "TERM", "TMPDIR", "TEMP", "TMP"],
      mcpServers: []
    },
    codexHandoff: {
      enabled: false,
      queuePath: ".secure-mcp/codex-tasks",
      maxPromptBytes: 24000,
      maxResultBytes: 200000,
      maxTasksListed: 50,
      taskTimeoutMs: 1800000,
      workerPollIntervalMs: 5000,
      workerHeartbeatIntervalMs: 5000,
      workerHeartbeatTtlMs: 15000,
      cancellationPollIntervalMs: 50,
      cancellationGraceMs: 100,
      failOnContextDrift: true,
      codexCommand: "codex",
      codexArgs: [
        "exec",
        "--sandbox",
        "workspace-write",
        "--ask-for-approval",
        "never",
        "--json",
        "-"
      ],
      allowedEnvKeys: [
        "PATH",
        "HOME",
        "USER",
        "USERNAME",
        "LANG",
        "LC_ALL",
        "TERM",
        "TMPDIR",
        "TEMP",
        "TMP",
        "SHELL",
        "CODEX_HOME"
      ],
      allowedEnvPrefixes: ["CODEX_"]
    }
  };

  return {
    ...config,
    ...overrides,
    server: { ...config.server, ...overrides.server },
    workspace: { ...config.workspace, ...overrides.workspace },
    sandbox: { ...config.sandbox, ...overrides.sandbox },
    policy: { ...config.policy, ...overrides.policy },
    audit: { ...config.audit, ...overrides.audit },
    extensions: { ...config.extensions, ...overrides.extensions },
    codexHandoff: { ...config.codexHandoff, ...overrides.codexHandoff }
  };
}
