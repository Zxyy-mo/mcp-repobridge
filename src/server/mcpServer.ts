import type { RuntimeConfig } from "../config/config.js";
import { timingSafeEqual, randomUUID } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  auditLogTailTool,
  codexTaskCancelTool,
  codexTaskCreateTool,
  codexTaskListTool,
  codexTaskStatusTool,
  codexTaskTailTool,
  execContainerTool,
  extensionDiscoverTool,
  findFilesTool,
  grepFilesTool,
  listDirectoryTool,
  mcpCallTool,
  projectTaskListTool,
  projectTaskRunTool,
  readFileTool,
  readFilesTool,
  sandboxStartTool,
  sandboxStatusTool,
  sandboxStopTool,
  sandboxTaskCancelTool,
  sandboxTaskStatusTool,
  sandboxTaskTailTool,
  skillReadTool,
  workspaceBootstrapTool,
  workspaceInfoTool
} from "../tools/index.js";
import { safeToolCall } from "./toolEnvelope.js";

export const BASE_REGISTERED_TOOL_NAMES = [
  "read_file",
  "read_files",
  "list_directory",
  "grep_files",
  "find_files",
  "project_task_list",
  "project_task_run",
  "exec_container",
  "sandbox_status",
  "sandbox_start",
  "sandbox_stop",
  "sandbox_task_status",
  "sandbox_task_tail",
  "sandbox_task_cancel",
  "workspace_bootstrap",
  "workspace_info",
  "audit_log_tail"
] as const;

export const CODEX_HANDOFF_TOOL_NAMES = [
  "codex_task_create",
  "codex_task_list",
  "codex_task_status",
  "codex_task_tail",
  "codex_task_cancel"
] as const;

export const EXTENSION_TOOL_NAMES = [
  "extension_discover",
  "skill_read"
] as const;

export const HOST_MCP_TOOL_NAMES = ["mcp_call"] as const;

export const REGISTERED_TOOL_NAMES = BASE_REGISTERED_TOOL_NAMES;

export function registeredToolNamesForConfig(config: RuntimeConfig): string[] {
  return [
    ...BASE_REGISTERED_TOOL_NAMES,
    ...(config.extensions.enabled ? EXTENSION_TOOL_NAMES : []),
    ...(config.extensions.enabled && config.extensions.hostMcpEnabled ? HOST_MCP_TOOL_NAMES : []),
    ...(config.codexHandoff.enabled ? CODEX_HANDOFF_TOOL_NAMES : [])
  ];
}

const MAX_HTTP_BODY_BYTES = 1024 * 1024;

export type RunningHttpMcpServer = {
  url: string;
  close(): Promise<void>;
};

type HttpMcpSession = {
  transport: StreamableHTTPServerTransport;
  createdAt: number;
  lastSeenAt: number;
};

export async function createMcpServer(config: RuntimeConfig): Promise<void | RunningHttpMcpServer> {
  if (config.server.transport === "stdio") {
    const server = createRegisteredMcpServer(config);
    await server.connect(new StdioServerTransport());
    return;
  }
  return startHttpMcpServer(config);
}

export function createRegisteredMcpServer(config: RuntimeConfig): McpServer {
  const server = new McpServer(
    {
      name: "mcp-repobridge",
      version: "0.1.1"
    },
    {
      instructions: [
        "Expose only read-only workspace file tools and Docker-only command execution.",
        "Do not provide host shell, host write/edit tools, or arbitrary Docker controls.",
        "When explicitly enabled, extension tools may read configured Skill instructions or call allowlisted tools on trusted, statically configured host MCP servers.",
        "When enabled, Codex handoff tools may queue local Codex work but do not execute it inside the MCP request."
      ].join(" ")
    }
  );

  registerSecureTools(server, config);
  return server;
}

export async function startHttpMcpServer(config: RuntimeConfig): Promise<RunningHttpMcpServer> {
  const trustedToken = process.env[config.server.authTokenEnv];
  if (!trustedToken) {
    throw new Error(`Missing bearer token environment variable: ${config.server.authTokenEnv}`);
  }
  const sessions = new Map<string, HttpMcpSession>();
  const httpServer = http.createServer(async (req, res) => {
    try {
      if (req.url !== "/mcp") {
        sendJson(res, 404, { error: "Not found" });
        return;
      }
      if (!validateHost(req, config.server.allowedHosts)) {
        sendJson(res, 403, { error: "Forbidden host" });
        return;
      }
      if (!validateOrigin(req, config.server.allowedOrigins)) {
        sendJson(res, 403, { error: "Forbidden origin" });
        return;
      }
      applyCorsHeaders(req, res, config.server.allowedOrigins);
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (!validateBearerToken(req, trustedToken)) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
      await pruneExpiredSessions(sessions, config.server.sessionTtlMs);

      const parsedBody = req.method === "POST" ? await readJsonBody(req) : undefined;
      const sessionId = req.headers["mcp-session-id"];
      const sessionIdValue = Array.isArray(sessionId) ? sessionId[0] : sessionId;
      const initializeRequest = req.method === "POST" && isInitializeRequest(parsedBody);
      let transport: StreamableHTTPServerTransport | undefined;

      if (sessionIdValue) {
        const session = sessions.get(sessionIdValue);
        if (!session) {
          sendJsonRpcError(res, 404, -32000, "Unknown MCP session");
          return;
        }
        session.lastSeenAt = Date.now();
        transport = session.transport;
      } else if (initializeRequest) {
        if (sessions.size >= config.server.maxSessions) {
          sendJsonRpcError(res, 429, -32000, "MCP session limit reached");
          return;
        }
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            if (transport) {
              sessions.set(newSessionId, {
                transport,
                createdAt: Date.now(),
                lastSeenAt: Date.now()
              });
            }
          }
        });
        transport.onclose = () => {
          const closedSessionId = transport?.sessionId;
          if (closedSessionId) sessions.delete(closedSessionId);
        };
        await createRegisteredMcpServer(config).connect(transport);
      } else {
        sendJsonRpcError(res, 400, -32000, "No valid MCP session");
        return;
      }

      await transport.handleRequest(req, res, parsedBody);
    } catch (error) {
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, error instanceof Error ? error.message : String(error));
      } else {
        res.end();
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.server.port, config.server.host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  return {
    url: `http://${config.server.host}:${addressPort(httpServer)}/mcp`,
    close: async () => {
      for (const session of sessions.values()) {
        await session.transport.close();
      }
      sessions.clear();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  };
}

export function registerSecureTools(server: McpServer, config: RuntimeConfig): void {
  server.registerTool(
    "read_file",
    {
      title: "Read file",
      description: "Read a byte range from a text file inside the configured workspace.",
      inputSchema: {
        path: z.string().min(1),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().positive().optional()
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async (input) => safeToolCall("read_file", () => readFileTool(config, input))
  );

  server.registerTool(
    "read_files",
    {
      title: "Read files",
      description: "Read bounded ranges from multiple workspace files under one total result budget.",
      inputSchema: {
        items: z.array(z.object({
          path: z.string().min(1),
          offset: z.number().int().min(0).optional(),
          limit: z.number().int().positive().optional()
        })).min(1).max(config.workspace.maxBatchReadItems),
        maxTotalBytes: z.number().int().positive().optional()
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async (input) => safeToolCall("read_files", () => readFilesTool(config, input))
  );

  server.registerTool(
    "list_directory",
    {
      title: "List directory",
      description: "List entries in a workspace directory with a configured result cap.",
      inputSchema: {
        path: z.string().min(1),
        limit: z.number().int().positive().optional(),
        cursor: z.string().max(4096).optional()
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async (input) => safeToolCall("list_directory", () => listDirectoryTool(config, input))
  );

  server.registerTool(
    "grep_files",
    {
      title: "Grep files",
      description: "Search text files inside the configured workspace using a JavaScript regular expression.",
      inputSchema: {
        pattern: z.string().min(1),
        path: z.string().min(1).optional(),
        include: z.array(z.string().min(1)).optional(),
        exclude: z.array(z.string().min(1)).optional(),
        maxMatches: z.number().int().positive().optional(),
        cursor: z.string().max(4096).optional()
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async (input) => safeToolCall("grep_files", () => grepFilesTool(config, input))
  );

  server.registerTool(
    "find_files",
    {
      title: "Find files",
      description: "Find workspace files and directories with a safe glob pattern.",
      inputSchema: {
        pattern: z.string().min(1),
        path: z.string().min(1).optional(),
        maxResults: z.number().int().positive().optional(),
        cursor: z.string().max(4096).optional()
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async (input) => safeToolCall("find_files", () => findFilesTool(config, input))
  );

  server.registerTool(
    "project_task_list",
    {
      title: "Project tasks",
      description: "Discover bounded test, build, lint, and custom tasks from fixed project manifest files.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () => safeToolCall("project_task_list", () => projectTaskListTool(config))
  );

  server.registerTool(
    "project_task_run",
    {
      title: "Run project task",
      description: "Resolve a discovered project task server-side and run it through policy in the fixed sandbox.",
      inputSchema: {
        name: z.string().min(1).max(200),
        timeoutMs: z.number().int().positive().optional(),
        yieldMs: z.number().int().positive().optional()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (input) => safeToolCall("project_task_run", () => projectTaskRunTool(config, input))
  );

  server.registerTool(
    "exec_container",
    {
      title: "Execute in Docker sandbox",
      description: "Run a command through docker exec in the fixed configured sandbox container.",
      inputSchema: {
        command: z.string().min(1),
        workdir: z.string().min(1).optional(),
        timeoutMs: z.number().int().positive().optional(),
        yieldMs: z.number().int().positive().optional()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (input) => safeToolCall("exec_container", () => execContainerTool(config, input))
  );

  server.registerTool(
    "sandbox_task_status",
    {
      title: "Sandbox task status",
      description: "Read the durable status and result metadata for a sandbox command task.",
      inputSchema: { taskId: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async (input) => safeToolCall("sandbox_task_status", () => sandboxTaskStatusTool(config, input))
  );

  server.registerTool(
    "sandbox_task_tail",
    {
      title: "Sandbox task output",
      description: "Read bounded stdout and stderr ranges from a durable sandbox command task.",
      inputSchema: {
        taskId: z.string().min(1),
        stdoutOffset: z.number().int().min(0).optional(),
        stderrOffset: z.number().int().min(0).optional(),
        maxBytes: z.number().int().positive().optional()
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async (input) => safeToolCall("sandbox_task_tail", () => sandboxTaskTailTool(config, input))
  );

  server.registerTool(
    "sandbox_task_cancel",
    {
      title: "Cancel sandbox task",
      description: "Request termination of one running command inside the fixed sandbox.",
      inputSchema: {
        taskId: z.string().min(1),
        reason: z.string().min(1).optional()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (input) => safeToolCall("sandbox_task_cancel", () => sandboxTaskCancelTool(config, input))
  );

  server.registerTool(
    "sandbox_status",
    {
      title: "Sandbox status",
      description: "Inspect whether the fixed configured Docker sandbox container is running.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () => safeToolCall("sandbox_status", () => sandboxStatusTool(config))
  );

  server.registerTool(
    "sandbox_start",
    {
      title: "Start sandbox",
      description: "Start the fixed configured Docker sandbox container using trusted runtime config.",
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => safeToolCall("sandbox_start", () => sandboxStartTool(config))
  );

  server.registerTool(
    "sandbox_stop",
    {
      title: "Stop sandbox",
      description: "Stop and remove the fixed configured Docker sandbox container.",
      inputSchema: {},
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => safeToolCall("sandbox_stop", () => sandboxStopTool(config))
  );

  server.registerTool(
    "workspace_bootstrap",
    {
      title: "Workspace bootstrap",
      description: "Return one actionable readiness snapshot for the workspace, sandbox, project, and optional Codex worker.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () => safeToolCall("workspace_bootstrap", () => workspaceBootstrapTool(config))
  );

  server.registerTool(
    "workspace_info",
    {
      title: "Workspace info",
      description: "Return non-secret runtime configuration details for the configured workspace and sandbox.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () => safeToolCall("workspace_info", () => workspaceInfoTool(config))
  );

  if (config.extensions.enabled) {
    server.registerTool(
      "extension_discover",
      {
        title: "Discover configured extensions",
        description: "List or describe configured document Skills and trusted local MCP servers. Describing an MCP server starts only its fixed configured command to obtain allowlisted tool schemas.",
        inputSchema: {
          kind: z.enum(["skill", "mcp"]),
          name: z.string().min(1).max(200).optional(),
          query: z.string().min(1).max(500).optional()
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true
        }
      },
      async (input) => safeToolCall("extension_discover", () => extensionDiscoverTool(config, input))
    );

    server.registerTool(
      "skill_read",
      {
        title: "Read configured Skill",
        description: "Read bounded Markdown instructions from a configured Skill revision. This tool never executes Skill code.",
        inputSchema: {
          name: z.string().min(1).max(200),
          revision: z.string().min(1).max(200),
          offset: z.number().int().min(0).optional(),
          limit: z.number().int().positive().optional()
        },
        annotations: { readOnlyHint: true, openWorldHint: false }
      },
      async (input) => safeToolCall("skill_read", () => skillReadTool(config, input))
    );

    if (config.extensions.hostMcpEnabled) {
      server.registerTool(
        "mcp_call",
        {
          title: "Call configured local MCP tool",
          description: "Call one allowlisted tool on a trusted, statically configured stdio MCP server after explicit discovery. The client cannot supply the host command, arguments, working directory, or environment.",
          inputSchema: {
            server: z.string().min(1).max(200),
            tool: z.string().min(1).max(300),
            arguments: z.record(z.string(), z.unknown()).optional(),
            discoveryId: z.string().min(1).max(100),
            discoveryRevision: z.string().min(1).max(100)
          },
          annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: true
          }
        },
        async (input) => safeToolCall("mcp_call", () => mcpCallTool(config, input))
      );
    }
  }

  server.registerTool(
    "audit_log_tail",
    {
      title: "Audit log tail",
      description: "Return the most recent sanitized audit records from the fixed configured audit log.",
      inputSchema: {
        lines: z.number().int().positive().max(200).optional()
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async (input) => safeToolCall("audit_log_tail", () => auditLogTailTool(config, input))
  );

  if (config.codexHandoff.enabled) {
    server.registerTool(
      "codex_task_create",
      {
        title: "Create Codex task",
        description: "Queue a structured task for a local Codex worker to execute outside this MCP request.",
        inputSchema: {
          title: z.string().min(1).max(300),
          prompt: z.string().min(1),
          acceptanceCriteria: z.array(z.string().min(1)).max(20).optional(),
          relevantFiles: z.array(z.string().min(1)).max(50).optional(),
          priority: z.enum(["low", "normal", "high"]).optional(),
          idempotencyKey: z.string().min(1).max(200).optional()
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false
        }
      },
      async (input) => safeToolCall("codex_task_create", () => codexTaskCreateTool(config, input))
    );

    server.registerTool(
      "codex_task_list",
      {
        title: "List Codex tasks",
        description: "List queued and completed Codex handoff tasks.",
        inputSchema: {
          status: z.enum(["queued", "running", "succeeded", "failed", "canceled"]).optional(),
          limit: z.number().int().positive().optional()
        },
        annotations: { readOnlyHint: true, openWorldHint: false }
      },
      async (input) => safeToolCall("codex_task_list", () => codexTaskListTool(config, input))
    );

    server.registerTool(
      "codex_task_status",
      {
        title: "Codex task status",
        description: "Return the current status and result metadata for one Codex handoff task.",
        inputSchema: {
          taskId: z.string().min(1),
          includePrompt: z.boolean().optional()
        },
        annotations: { readOnlyHint: true, openWorldHint: false }
      },
      async (input) => safeToolCall("codex_task_status", () => codexTaskStatusTool(config, input))
    );

    server.registerTool(
      "codex_task_tail",
      {
        title: "Codex task log tail",
        description: "Return the tail of the local worker log for one Codex handoff task.",
        inputSchema: {
          taskId: z.string().min(1),
          offset: z.number().int().min(0).optional(),
          bytes: z.number().int().positive().optional()
        },
        annotations: { readOnlyHint: true, openWorldHint: false }
      },
      async (input) => safeToolCall("codex_task_tail", () => codexTaskTailTool(config, input))
    );

    server.registerTool(
      "codex_task_cancel",
      {
        title: "Cancel Codex task",
        description: "Cancel a queued task or request cooperative cancellation from a running local Codex worker.",
        inputSchema: {
          taskId: z.string().min(1),
          reason: z.string().min(1).optional()
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false
        }
      },
      async (input) => safeToolCall("codex_task_cancel", () => codexTaskCancelTool(config, input))
    );
  }
}

function validateHost(req: IncomingMessage, allowedHosts: string[]): boolean {
  if (allowedHosts.length === 0) return true;
  const host = req.headers.host;
  const hostValue = Array.isArray(host) ? host[0] : host;
  if (!hostValue) return false;
  const normalizedHost = normalizeHostName(hostValue);
  return allowedHosts.some((allowedHost) => hostMatches(allowedHost, normalizedHost));
}

function hostMatches(allowedHost: string, actualHost: string): boolean {
  const normalizedAllowed = normalizeHostName(allowedHost);
  if (normalizedAllowed === "*") return true;
  if (normalizedAllowed.startsWith("*.")) {
    const suffix = normalizedAllowed.slice(1);
    return actualHost.endsWith(suffix) && actualHost.length > suffix.length;
  }
  return actualHost === normalizedAllowed;
}

function normalizeHostName(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized.startsWith("[")) {
    const end = normalized.indexOf("]");
    return end >= 0 ? normalized.slice(1, end) : normalized;
  }
  return normalized.replace(/:\d+$/, "");
}

async function pruneExpiredSessions(sessions: Map<string, HttpMcpSession>, sessionTtlMs: number): Promise<void> {
  const now = Date.now();
  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.lastSeenAt <= sessionTtlMs) continue;
    sessions.delete(sessionId);
    try {
      await session.transport.close();
    } catch {
      // Session cleanup is best-effort; the map entry is already gone.
    }
  }
}

function validateOrigin(req: IncomingMessage, allowedOrigins: string[]): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  const originValue = Array.isArray(origin) ? origin[0] : origin;
  return allowedOrigins.includes(originValue);
}

function applyCorsHeaders(req: IncomingMessage, res: ServerResponse, allowedOrigins: string[]): void {
  const origin = req.headers.origin;
  if (!origin) return;
  const originValue = Array.isArray(origin) ? origin[0] : origin;
  if (!allowedOrigins.includes(originValue)) return;
  res.setHeader("Access-Control-Allow-Origin", originValue);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "authorization, content-type, mcp-session-id");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
}

function validateBearerToken(req: IncomingMessage, trustedToken: string): boolean {
  const authorization = req.headers.authorization;
  const value = Array.isArray(authorization) ? authorization[0] : authorization;
  if (!value?.startsWith("Bearer ")) return false;
  const providedToken = value.slice("Bearer ".length);
  const provided = Buffer.from(providedToken);
  const trusted = Buffer.from(trustedToken);
  return provided.length === trusted.length && timingSafeEqual(provided, trusted);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_HTTP_BODY_BYTES) {
      throw new Error("HTTP request body exceeds limit");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendJsonRpcError(res: ServerResponse, httpStatus: number, code: number, message: string): void {
  sendJson(res, httpStatus, {
    jsonrpc: "2.0",
    error: { code, message },
    id: null
  });
}

function addressPort(server: http.Server): number {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("HTTP server did not expose a TCP port");
  }
  return address.port;
}
