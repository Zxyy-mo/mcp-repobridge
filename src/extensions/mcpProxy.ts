import { createHash, randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { RuntimeConfig } from "../config/config.js";
import { StructuredToolError } from "../policy/errors.js";

type ConfiguredMcpServer = RuntimeConfig["extensions"]["mcpServers"][number];

export type UpstreamToolDescriptor = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  metadataTrust: "untrusted-upstream-metadata";
};

type McpDiscoveryLease = {
  id: string;
  workspaceRoot: string;
  server: string;
  revision: string;
  expiresAtMs: number;
  tools: Map<string, UpstreamToolDescriptor>;
};

const discoveryLeases = new Map<string, McpDiscoveryLease>();
const MAX_DISCOVERY_LEASES = 1000;
let activeMcpProcesses = 0;

export function listConfiguredMcpServers(config: RuntimeConfig, query?: string) {
  ensureExtensionsEnabled(config);
  const normalizedQuery = query?.trim().toLowerCase();
  return config.extensions.mcpServers
    .filter((server) => server.enabled)
    .filter((server) => !normalizedQuery || server.name.toLowerCase().includes(normalizedQuery) || server.description?.toLowerCase().includes(normalizedQuery))
    .map((server) => ({
      name: server.name,
      description: server.description,
      transport: "stdio" as const,
      hostExecution: true,
      state: config.extensions.hostMcpEnabled ? "available" as const : "host_execution_disabled" as const,
      allowedTools: server.allowedTools.length
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function discoverMcpServer(config: RuntimeConfig, serverName: string) {
  ensureHostMcpEnabled(config);
  const server = configuredServer(config, serverName);
  let tools: UpstreamToolDescriptor[];
  try {
    tools = await withUpstreamClient(config, server, async (client) => {
      const discovered = await listAllTools(client, config.extensions.connectTimeoutMs, config.extensions.maxToolsPerServer);
      return discovered
        .filter((tool) => toolAllowed(server, tool.name))
        .map(sanitizeTool)
        .sort((left, right) => left.name.localeCompare(right.name));
    });
  } catch (error) {
    if (error instanceof StructuredToolError) throw error;
    throw new StructuredToolError({
      code: "MCP_DISCOVERY_FAILED",
      category: "runtime",
      message: `The configured MCP server could not be discovered: ${serverName}`,
      retryable: true
    });
  }
  assertWithinBudget(config, { tools }, "MCP_DISCOVERY_RESULT_TOO_LARGE");
  const revision = revisionForTools(tools);
  const lease: McpDiscoveryLease = {
    id: `disc_${randomUUID()}`,
    workspaceRoot: config.workspace.root,
    server: server.name,
    revision,
    expiresAtMs: Date.now() + config.extensions.discoveryTtlMs,
    tools: new Map(tools.map((tool) => [tool.name, tool]))
  };
  pruneExpiredLeases();
  evictDiscoveryLeaseIfNeeded();
  discoveryLeases.set(lease.id, lease);
  return {
    server: {
      name: server.name,
      description: server.description,
      transport: "stdio" as const,
      hostExecution: true,
      tools
    },
    discoveryId: lease.id,
    discoveryRevision: lease.revision,
    expiresAt: new Date(lease.expiresAtMs).toISOString(),
    invocationTemplate: {
      tool: "mcp_call",
      arguments: {
        server: server.name,
        tool: "<tool from discovery>",
        arguments: {},
        discoveryId: lease.id,
        discoveryRevision: lease.revision
      },
      reason: "Call only a tool and schema returned by this discovery response."
    }
  };
}

export async function callDiscoveredMcpTool(
  config: RuntimeConfig,
  input: {
    server: string;
    tool: string;
    arguments?: Record<string, unknown>;
    discoveryId: string;
    discoveryRevision: string;
  }
) {
  ensureHostMcpEnabled(config);
  const server = configuredServer(config, input.server);
  const lease = requireLease(config, input);
  const descriptor = lease.tools.get(input.tool);
  if (!descriptor || !toolAllowed(server, input.tool)) {
    throw staleDiscoveryError(input.server, "The requested tool was not present in the discovered allowlisted schema.");
  }
  let upstream: Awaited<ReturnType<Client["callTool"]>>;
  try {
    upstream = await withUpstreamClient(config, server, (client) => client.callTool(
      { name: input.tool, arguments: input.arguments ?? {} },
      undefined,
      {
        timeout: config.extensions.callTimeoutMs,
        maxTotalTimeout: config.extensions.callTimeoutMs
      }
    ));
  } catch (error) {
    if (error instanceof StructuredToolError) throw error;
    throw new StructuredToolError({
      code: "MCP_CALL_FAILED",
      category: "execution",
      message: `The configured MCP tool call failed: ${input.server}/${input.tool}`,
      retryable: false
    });
  }
  const resultBytes = Buffer.byteLength(JSON.stringify(upstream), "utf8");
  if (resultBytes > config.extensions.maxResultBytes) {
    throw new StructuredToolError({
      code: "MCP_RESULT_TOO_LARGE",
      category: "execution",
      message: `The upstream MCP result exceeds the ${config.extensions.maxResultBytes} byte response budget.`,
      retryable: true,
      details: { resultBytes, maxResultBytes: config.extensions.maxResultBytes }
    });
  }
  return {
    server: input.server,
    tool: input.tool,
    discoveryRevision: lease.revision,
    resultBytes,
    contentTrust: "untrusted-upstream-output" as const,
    upstream
  };
}

function ensureExtensionsEnabled(config: RuntimeConfig): void {
  if (!config.extensions.enabled) {
    throw new StructuredToolError({
      code: "EXTENSIONS_DISABLED",
      category: "permission",
      message: "The extension gateway is disabled by trusted runtime configuration."
    });
  }
}

function ensureHostMcpEnabled(config: RuntimeConfig): void {
  ensureExtensionsEnabled(config);
  if (!config.extensions.hostMcpEnabled) {
    throw new StructuredToolError({
      code: "HOST_MCP_DISABLED",
      category: "permission",
      message: "Host MCP process execution is disabled by trusted runtime configuration."
    });
  }
}

function configuredServer(config: RuntimeConfig, name: string): ConfiguredMcpServer {
  const server = config.extensions.mcpServers.find((candidate) => candidate.enabled && candidate.name === name);
  if (!server) {
    throw new StructuredToolError({
      code: "MCP_SERVER_NOT_FOUND",
      category: "not_found",
      message: `Configured MCP server was not found: ${name}`,
      recovery: {
        tool: "extension_discover",
        arguments: { kind: "mcp" },
        reason: "Refresh the trusted configured MCP server names."
      }
    });
  }
  return server;
}

function requireLease(
  config: RuntimeConfig,
  input: { server: string; discoveryId: string; discoveryRevision: string }
): McpDiscoveryLease {
  pruneExpiredLeases();
  const lease = discoveryLeases.get(input.discoveryId);
  if (
    !lease ||
    lease.workspaceRoot !== config.workspace.root ||
    lease.server !== input.server ||
    lease.revision !== input.discoveryRevision ||
    lease.expiresAtMs <= Date.now()
  ) {
    throw staleDiscoveryError(input.server, "MCP discovery is missing, expired, or does not match this workspace/server/revision.");
  }
  return lease;
}

function staleDiscoveryError(server: string, message: string): StructuredToolError {
  return new StructuredToolError({
    code: "MCP_DISCOVERY_STALE",
    category: "runtime",
    message,
    retryable: true,
    recovery: {
      tool: "extension_discover",
      arguments: { kind: "mcp", name: server },
      reason: "Rediscover the configured MCP server and use the returned ID, revision, tool name, and schema."
    }
  });
}

async function withUpstreamClient<T>(
  config: RuntimeConfig,
  server: ConfiguredMcpServer,
  call: (client: Client) => Promise<T>
): Promise<T> {
  const environment = buildUpstreamEnvironment(config, server);
  if (activeMcpProcesses >= config.extensions.maxConcurrentMcpProcesses) {
    throw new StructuredToolError({
      code: "MCP_PROCESS_LIMIT_REACHED",
      category: "runtime",
      message: "The configured host MCP process concurrency limit has been reached.",
      retryable: true
    });
  }
  activeMcpProcesses += 1;
  let client: Client | undefined;
  try {
    const transport = new StdioClientTransport({
      command: server.command,
      args: server.args,
      cwd: config.workspace.root,
      env: environment,
      stderr: "pipe"
    });
    transport.stderr?.on("data", () => undefined);
    client = new Client(
      { name: "mcp-repobridge-extension-gateway", version: "0.1.1" },
      { capabilities: {} }
    );
    await client.connect(transport, {
      timeout: config.extensions.connectTimeoutMs,
      maxTotalTimeout: config.extensions.connectTimeoutMs
    });
    return await call(client);
  } finally {
    await client?.close().catch(() => undefined);
    activeMcpProcesses -= 1;
  }
}

async function listAllTools(client: Client, timeoutMs: number, maxTools: number) {
  const tools: Array<Awaited<ReturnType<Client["listTools"]>>["tools"][number]> = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined, {
      timeout: timeoutMs,
      maxTotalTimeout: timeoutMs
    });
    tools.push(...page.tools);
    if (tools.length > maxTools) {
      throw new StructuredToolError({
        code: "MCP_TOOL_LIMIT_EXCEEDED",
        category: "runtime",
        message: `The upstream MCP server exposes more than the configured ${maxTools} tool limit.`
      });
    }
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

function sanitizeTool(tool: Awaited<ReturnType<Client["listTools"]>>["tools"][number]): UpstreamToolDescriptor {
  return {
    name: tool.name,
    title: tool.title?.slice(0, 300),
    description: tool.description?.slice(0, 2000),
    inputSchema: tool.inputSchema as Record<string, unknown>,
    outputSchema: tool.outputSchema as Record<string, unknown> | undefined,
    annotations: tool.annotations
      ? {
        readOnlyHint: tool.annotations.readOnlyHint,
        destructiveHint: tool.annotations.destructiveHint,
        idempotentHint: tool.annotations.idempotentHint,
        openWorldHint: tool.annotations.openWorldHint
      }
      : undefined,
    metadataTrust: "untrusted-upstream-metadata"
  };
}

function buildUpstreamEnvironment(config: RuntimeConfig, server: ConfiguredMcpServer): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of config.extensions.safeEnvKeys) {
    const value = process.env[key];
    if (value !== undefined && !value.startsWith("()")) env[key] = value;
  }
  for (const [target, source] of Object.entries(server.envFromHost)) {
    const value = process.env[source];
    if (value === undefined) {
      throw new StructuredToolError({
        code: "MCP_ENV_MISSING",
        category: "runtime",
        message: `A configured host environment variable required by MCP server ${server.name} is missing.`,
        retryable: true,
        details: { target }
      });
    }
    env[target] = value;
  }
  return env;
}

function toolAllowed(server: ConfiguredMcpServer, tool: string): boolean {
  return server.allowedTools.includes(tool);
}

function revisionForTools(tools: UpstreamToolDescriptor[]): string {
  return `sha256:${createHash("sha256").update(stableStringify(tools)).digest("hex")}`;
}

function assertWithinBudget(config: RuntimeConfig, value: unknown, code: string): void {
  const resultBytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (resultBytes > config.extensions.maxResultBytes) {
    throw new StructuredToolError({
      code,
      category: "runtime",
      message: `The extension discovery result exceeds the ${config.extensions.maxResultBytes} byte response budget.`,
      details: { resultBytes, maxResultBytes: config.extensions.maxResultBytes }
    });
  }
}

function pruneExpiredLeases(): void {
  const now = Date.now();
  for (const [id, lease] of discoveryLeases) {
    if (lease.expiresAtMs <= now) discoveryLeases.delete(id);
  }
}

function evictDiscoveryLeaseIfNeeded(): void {
  if (discoveryLeases.size < MAX_DISCOVERY_LEASES) return;
  let oldest: McpDiscoveryLease | undefined;
  for (const lease of discoveryLeases.values()) {
    if (!oldest || lease.expiresAtMs < oldest.expiresAtMs) oldest = lease;
  }
  if (oldest) discoveryLeases.delete(oldest.id);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
