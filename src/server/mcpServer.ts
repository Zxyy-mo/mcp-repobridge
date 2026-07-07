import type { RuntimeConfig } from "../config/config.js";
import { timingSafeEqual, randomUUID } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
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
  findFilesTool,
  grepFilesTool,
  listDirectoryTool,
  readFileTool,
  sandboxStartTool,
  sandboxStatusTool,
  sandboxStopTool,
  workspaceInfoTool
} from "../tools/index.js";

export const BASE_REGISTERED_TOOL_NAMES = [
  "read_file",
  "list_directory",
  "grep_files",
  "find_files",
  "exec_container",
  "sandbox_status",
  "sandbox_start",
  "sandbox_stop",
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

export const REGISTERED_TOOL_NAMES = BASE_REGISTERED_TOOL_NAMES;

export function registeredToolNamesForConfig(config: RuntimeConfig): string[] {
  return config.codexHandoff.enabled
    ? [...BASE_REGISTERED_TOOL_NAMES, ...CODEX_HANDOFF_TOOL_NAMES]
    : [...BASE_REGISTERED_TOOL_NAMES];
}

const MAX_HTTP_BODY_BYTES = 1024 * 1024;

export type RunningHttpMcpServer = {
  url: string;
  close(): Promise<void>;
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
      version: "0.1.0"
    },
    {
      instructions: [
        "Expose only read-only workspace file tools and Docker-only command execution.",
        "Do not provide host shell, host write/edit tools, or arbitrary Docker controls.",
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
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const httpServer = http.createServer(async (req, res) => {
    try {
      if (req.url !== "/mcp") {
        sendJson(res, 404, { error: "Not found" });
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

      const parsedBody = req.method === "POST" ? await readJsonBody(req) : undefined;
      const sessionId = req.headers["mcp-session-id"];
      const sessionIdValue = Array.isArray(sessionId) ? sessionId[0] : sessionId;
      const initializeRequest = req.method === "POST" && isInitializeRequest(parsedBody);
      let transport: StreamableHTTPServerTransport | undefined;

      if (sessionIdValue) {
        transport = transports.get(sessionIdValue);
        if (!transport) {
          sendJsonRpcError(res, 404, -32000, "Unknown MCP session");
          return;
        }
      } else if (initializeRequest) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            if (transport) transports.set(newSessionId, transport);
          }
        });
        transport.onclose = () => {
          const closedSessionId = transport?.sessionId;
          if (closedSessionId) transports.delete(closedSessionId);
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
      for (const transport of transports.values()) {
        await transport.close();
      }
      transports.clear();
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
    async (input) => toolResult(await readFileTool(config, input))
  );

  server.registerTool(
    "list_directory",
    {
      title: "List directory",
      description: "List entries in a workspace directory with a configured result cap.",
      inputSchema: {
        path: z.string().min(1),
        limit: z.number().int().positive().optional()
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async (input) => toolResult(await listDirectoryTool(config, input))
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
        maxMatches: z.number().int().positive().optional()
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async (input) => toolResult(await grepFilesTool(config, input))
  );

  server.registerTool(
    "find_files",
    {
      title: "Find files",
      description: "Find workspace files and directories with a safe glob pattern.",
      inputSchema: {
        pattern: z.string().min(1),
        path: z.string().min(1).optional(),
        maxResults: z.number().int().positive().optional()
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async (input) => toolResult(await findFilesTool(config, input))
  );

  server.registerTool(
    "exec_container",
    {
      title: "Execute in Docker sandbox",
      description: "Run a command through docker exec in the fixed configured sandbox container.",
      inputSchema: {
        command: z.string().min(1),
        workdir: z.string().min(1).optional(),
        timeoutMs: z.number().int().positive().optional()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async (input) => toolResult(await execContainerTool(config, input))
  );

  server.registerTool(
    "sandbox_status",
    {
      title: "Sandbox status",
      description: "Inspect whether the fixed configured Docker sandbox container is running.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () => toolResult(await sandboxStatusTool(config))
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
    async () => toolResult(await sandboxStartTool(config))
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
    async () => toolResult(await sandboxStopTool(config))
  );

  server.registerTool(
    "workspace_info",
    {
      title: "Workspace info",
      description: "Return non-secret runtime configuration details for the configured workspace and sandbox.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () => toolResult(await workspaceInfoTool(config))
  );

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
    async (input) => toolResult(await auditLogTailTool(config, input))
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
          priority: z.enum(["low", "normal", "high"]).optional()
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false
        }
      },
      async (input) => toolResult(await codexTaskCreateTool(config, input))
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
      async (input) => toolResult(await codexTaskListTool(config, input))
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
      async (input) => toolResult(await codexTaskStatusTool(config, input))
    );

    server.registerTool(
      "codex_task_tail",
      {
        title: "Codex task log tail",
        description: "Return the tail of the local worker log for one Codex handoff task.",
        inputSchema: {
          taskId: z.string().min(1),
          bytes: z.number().int().positive().optional()
        },
        annotations: { readOnlyHint: true, openWorldHint: false }
      },
      async (input) => toolResult(await codexTaskTailTool(config, input))
    );

    server.registerTool(
      "codex_task_cancel",
      {
        title: "Cancel Codex task",
        description: "Cancel a queued Codex handoff task before a local worker starts it.",
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
      async (input) => toolResult(await codexTaskCancelTool(config, input))
    );
  }
}

function toolResult(result: unknown): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result, null, 2)
      }
    ],
    structuredContent: result as Record<string, unknown>
  };
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
