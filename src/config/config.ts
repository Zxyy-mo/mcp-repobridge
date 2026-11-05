import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const EXTENSION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

const ExtensionsSchema = z.object({
  enabled: z.boolean().default(false),
  hostMcpEnabled: z.boolean().default(false),
  skillDirs: z.array(z.string().min(1)).max(100).default([]),
  maxSkills: z.number().int().positive().max(1000).default(100),
  maxSkillBytes: z.number().int().positive().default(131072),
  discoveryTtlMs: z.number().int().positive().default(300000),
  connectTimeoutMs: z.number().int().positive().default(10000),
  callTimeoutMs: z.number().int().positive().default(60000),
  maxResultBytes: z.number().int().positive().default(262144),
  maxToolsPerServer: z.number().int().positive().max(1000).default(100),
  maxConcurrentMcpProcesses: z.number().int().positive().max(64).default(4),
  safeEnvKeys: z.array(z.string().regex(ENV_NAME_PATTERN)).default([
    "PATH",
    "HOME",
    "USER",
    "USERNAME",
    "LANG",
    "LC_ALL",
    "TERM",
    "TMPDIR",
    "TEMP",
    "TMP"
  ]),
  mcpServers: z.array(z.object({
    name: z.string().regex(EXTENSION_NAME_PATTERN),
    description: z.string().max(500).optional(),
    enabled: z.boolean().default(true),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    allowedTools: z.array(z.string().min(1).max(300).refine((name) => name !== "*", {
      message: "Wildcard MCP tool access is not supported; list each trusted tool explicitly"
    })).min(1).refine((names) => new Set(names).size === names.length, {
      message: "MCP allowedTools entries must be unique"
    }),
    envFromHost: z.record(
      z.string().regex(ENV_NAME_PATTERN),
      z.string().regex(ENV_NAME_PATTERN)
    ).default({})
  })).max(100).default([])
}).default({
  enabled: false,
  hostMcpEnabled: false,
  skillDirs: [],
  maxSkills: 100,
  maxSkillBytes: 131072,
  discoveryTtlMs: 300000,
  connectTimeoutMs: 10000,
  callTimeoutMs: 60000,
  maxResultBytes: 262144,
  maxToolsPerServer: 100,
  maxConcurrentMcpProcesses: 4,
  safeEnvKeys: ["PATH", "HOME", "USER", "USERNAME", "LANG", "LC_ALL", "TERM", "TMPDIR", "TEMP", "TMP"],
  mcpServers: []
});

export const ConfigSchema = z.object({
  server: z.object({
    host: z.string().default("127.0.0.1"),
    port: z.number().int().min(0).max(65535).default(8765),
    transport: z.enum(["stdio", "streamable-http"]).default("stdio"),
    authTokenEnv: z.string().default("SECURE_MCP_TOKEN"),
    allowedOrigins: z.array(z.string()).default([
      "https://chatgpt.com",
      "https://chat.openai.com"
    ]),
    allowedHosts: z.array(z.string()).default([
      "127.0.0.1",
      "localhost",
      "*.trycloudflare.com"
    ]),
    maxSessions: z.number().int().positive().default(100),
    sessionTtlMs: z.number().int().positive().default(1800000)
  }),
  workspace: z.object({
    root: z.string(),
    containerPath: z.string().default("/workspace"),
    defaultMountMode: z.enum(["ro", "rw"]).default("ro"),
    maxReadBytes: z.number().int().positive().default(1048576),
    maxHashBytes: z.number().int().positive().default(16777216),
    maxBatchReadBytes: z.number().int().positive().default(4194304),
    maxBatchReadItems: z.number().int().positive().max(100).default(20),
    maxDirectoryEntries: z.number().int().positive().default(1000)
  }),
  sandbox: z.object({
    containerName: z.string(),
    image: z.string(),
    startMode: z.enum(["manual", "on-demand"]).default("on-demand"),
    network: z.string().default("none"),
    memory: z.string().default("2g"),
    cpus: z.string().default("2"),
    pidsLimit: z.number().int().positive().default(256),
    user: z.string().default("1000:1000"),
    readOnlyRootfs: z.boolean().default(true),
    tmpfs: z.array(z.string()).default(["/tmp:rw,nosuid,nodev,size=512m"]),
    timeoutMs: z.number().int().positive().default(30000),
    maxOutputBytes: z.number().int().positive().default(200000),
    taskPath: z.string().default(".secure-mcp/sandbox-tasks"),
    commandYieldMs: z.number().int().positive().default(8000),
    maxTaskLogBytes: z.number().int().positive().default(1048576),
    taskCancelGraceMs: z.number().int().positive().default(2000)
  }),
  policy: z.object({
    allowExec: z.boolean().default(true),
    execMode: z.enum(["denylist", "allowlist"]).default("denylist"),
    allowedCommands: z.array(z.string()).optional(),
    denyNetworkCommands: z.boolean().default(true),
    denyDockerInsideContainer: z.boolean().default(true),
    denySecretsRead: z.boolean().default(true)
  }),
  audit: z.object({
    enabled: z.boolean().default(true),
    path: z.string().default(".secure-mcp/audit.log")
  }),
  extensions: ExtensionsSchema,
  codexHandoff: z.object({
    enabled: z.boolean().default(false),
    queuePath: z.string().default(".secure-mcp/codex-tasks"),
    maxPromptBytes: z.number().int().positive().default(24000),
    maxResultBytes: z.number().int().positive().default(200000),
    maxTasksListed: z.number().int().positive().default(50),
    taskTimeoutMs: z.number().int().positive().default(1800000),
    workerPollIntervalMs: z.number().int().positive().default(5000),
    workerHeartbeatIntervalMs: z.number().int().positive().default(5000),
    workerHeartbeatTtlMs: z.number().int().positive().default(15000),
    cancellationPollIntervalMs: z.number().int().positive().default(1000),
    cancellationGraceMs: z.number().int().positive().default(2000),
    failOnContextDrift: z.boolean().default(true),
    codexCommand: z.string().min(1).default("codex"),
    codexArgs: z.array(z.string()).default([
      "exec",
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "never",
      "--json",
      "-"
    ]),
    allowedEnvKeys: z.array(z.string()).default([
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
    ]),
    allowedEnvPrefixes: z.array(z.string()).default(["CODEX_"])
  }).default({
    enabled: false,
    queuePath: ".secure-mcp/codex-tasks",
    maxPromptBytes: 24000,
    maxResultBytes: 200000,
    maxTasksListed: 50,
    taskTimeoutMs: 1800000,
    workerPollIntervalMs: 5000,
    workerHeartbeatIntervalMs: 5000,
    workerHeartbeatTtlMs: 15000,
    cancellationPollIntervalMs: 1000,
    cancellationGraceMs: 2000,
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
  })
});

export type RuntimeConfig = z.infer<typeof ConfigSchema>;

export async function loadConfig(configPath: string): Promise<RuntimeConfig> {
  const raw = await fs.readFile(configPath, "utf8");
  const parsed = ConfigSchema.parse(JSON.parse(raw));
  if (parsed.workspace.defaultMountMode === "rw") {
    throw new Error("workspace.defaultMountMode=rw is no longer supported; the sandbox uses a filtered ephemeral copy");
  }
  const root = path.resolve(parsed.workspace.root);
  if (!path.isAbsolute(root)) {
    throw new Error("workspace.root must be absolute after resolution");
  }
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) {
    throw new Error("workspace.root must be a directory");
  }
  const rootReal = await fs.realpath(root);
  const extensionNames = parsed.extensions.mcpServers.map((server) => server.name);
  if (new Set(extensionNames).size !== extensionNames.length) {
    throw new Error("extensions.mcpServers names must be unique");
  }
  return {
    ...parsed,
    workspace: {
      ...parsed.workspace,
      root: rootReal
    }
  };
}
