import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const ConfigSchema = z.object({
  server: z.object({
    host: z.string().default("127.0.0.1"),
    port: z.number().int().min(0).max(65535).default(8765),
    transport: z.enum(["stdio", "streamable-http"]).default("stdio"),
    authTokenEnv: z.string().default("SECURE_MCP_TOKEN"),
    allowedOrigins: z.array(z.string()).default([
      "https://chatgpt.com",
      "https://chat.openai.com"
    ])
  }),
  workspace: z.object({
    root: z.string(),
    containerPath: z.string().default("/workspace"),
    defaultMountMode: z.enum(["ro", "rw"]).default("ro"),
    maxReadBytes: z.number().int().positive().default(1048576),
    maxDirectoryEntries: z.number().int().positive().default(1000)
  }),
  sandbox: z.object({
    containerName: z.string(),
    image: z.string(),
    network: z.string().default("none"),
    memory: z.string().default("2g"),
    cpus: z.string().default("2"),
    pidsLimit: z.number().int().positive().default(256),
    user: z.string().default("1000:1000"),
    readOnlyRootfs: z.boolean().default(true),
    tmpfs: z.array(z.string()).default(["/tmp:rw,nosuid,nodev,size=512m"]),
    timeoutMs: z.number().int().positive().default(30000),
    maxOutputBytes: z.number().int().positive().default(200000)
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
  codexHandoff: z.object({
    enabled: z.boolean().default(false),
    queuePath: z.string().default(".secure-mcp/codex-tasks"),
    maxPromptBytes: z.number().int().positive().default(24000),
    maxResultBytes: z.number().int().positive().default(200000),
    maxTasksListed: z.number().int().positive().default(50),
    taskTimeoutMs: z.number().int().positive().default(1800000),
    workerPollIntervalMs: z.number().int().positive().default(5000),
    codexCommand: z.string().min(1).default("codex"),
    codexArgs: z.array(z.string()).default([
      "exec",
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "never",
      "--json",
      "-"
    ])
  }).default({
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
  })
});

export type RuntimeConfig = z.infer<typeof ConfigSchema>;

export async function loadConfig(configPath: string): Promise<RuntimeConfig> {
  const raw = await fs.readFile(configPath, "utf8");
  const parsed = ConfigSchema.parse(JSON.parse(raw));
  const root = path.resolve(parsed.workspace.root);
  if (!path.isAbsolute(root)) {
    throw new Error("workspace.root must be absolute after resolution");
  }
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) {
    throw new Error("workspace.root must be a directory");
  }
  const rootReal = await fs.realpath(root);
  return {
    ...parsed,
    workspace: {
      ...parsed.workspace,
      root: rootReal
    }
  };
}
