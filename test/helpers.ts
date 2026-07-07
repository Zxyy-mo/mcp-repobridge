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
      allowedOrigins: ["https://chatgpt.com", "https://chat.openai.com"]
    },
    workspace: {
      root,
      containerPath: "/workspace",
      defaultMountMode: "ro",
      maxReadBytes: 1024,
      maxDirectoryEntries: 100
    },
    sandbox: {
      containerName: "secure-mcp-sandbox-test",
      image: "secure-mcp-sandbox:test",
      network: "none",
      memory: "512m",
      cpus: "1",
      pidsLimit: 64,
      user: "1000:1000",
      readOnlyRootfs: true,
      tmpfs: ["/tmp:rw,nosuid,nodev,size=64m"],
      timeoutMs: 1000,
      maxOutputBytes: 4096
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
    codexHandoff: {
      enabled: false,
      queuePath: ".secure-mcp/codex-tasks",
      maxPromptBytes: 24000,
      maxResultBytes: 200000,
      maxTasksListed: 50,
      taskTimeoutMs: 1800000,
      workerPollIntervalMs: 5000,
      codexCommand: "codex",
      codexArgs: [
        "exec",
        "--sandbox",
        "workspace-write",
        "--ask-for-approval",
        "never",
        "--json",
        "-"
      ]
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
    codexHandoff: { ...config.codexHandoff, ...overrides.codexHandoff }
  };
}
