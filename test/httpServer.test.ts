import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REGISTERED_TOOL_NAMES, startHttpMcpServer, type RunningHttpMcpServer } from "../src/server/mcpServer.js";
import { testConfig } from "./helpers.js";

const TOKEN_ENV = "SECURE_MCP_TEST_TOKEN";
let running: RunningHttpMcpServer | undefined;
const tempRoots: string[] = [];

afterEach(async () => {
  if (running) {
    await running.close();
    running = undefined;
  }
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  delete process.env[TOKEN_ENV];
});

describe("streamable HTTP MCP server", () => {
  it("rejects missing bearer token", async () => {
    running = await startServer();

    const response = await fetch(running.url, {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify(initializeRequest())
    });

    expect(response.status).toBe(401);
  });

  it("rejects invalid bearer token", async () => {
    running = await startServer();

    const response = await fetch(running.url, {
      method: "POST",
      headers: {
        ...jsonHeaders(),
        authorization: "Bearer wrong"
      },
      body: JSON.stringify(initializeRequest())
    });

    expect(response.status).toBe(401);
  });

  it("rejects bad Origin before handling MCP", async () => {
    running = await startServer();

    const response = await fetch(running.url, {
      method: "POST",
      headers: {
        ...jsonHeaders(),
        authorization: "Bearer test-token",
        origin: "https://evil.example"
      },
      body: JSON.stringify(initializeRequest())
    });

    expect(response.status).toBe(403);
  });

  it("lists only the secure v1 tool surface over HTTP", async () => {
    running = await startServer();

    const initResponse = await fetch(running.url, {
      method: "POST",
      headers: {
        ...jsonHeaders(),
        authorization: "Bearer test-token",
        origin: "https://chatgpt.com"
      },
      body: JSON.stringify(initializeRequest())
    });
    expect(initResponse.status).toBe(200);
    const sessionId = initResponse.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();

    const listResponse = await fetch(running.url, {
      method: "POST",
      headers: {
        ...jsonHeaders(),
        authorization: "Bearer test-token",
        origin: "https://chatgpt.com",
        "mcp-session-id": sessionId ?? ""
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {}
      })
    });
    expect(listResponse.status).toBe(200);
    const listBody = await readMcpResponse(listResponse) as { result: { tools: Array<{ name: string }> } };
    const toolNames = listBody.result.tools.map((tool) => tool.name).sort();

    expect(toolNames).toEqual([...REGISTERED_TOOL_NAMES].sort());
    expect(toolNames.some((name) => /shell|host_exec|write|edit|docker/.test(name))).toBe(false);
  });
});

async function startServer(): Promise<RunningHttpMcpServer> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "secure-mcp-http-")));
  tempRoots.push(root);
  process.env[TOKEN_ENV] = "test-token";
  return startHttpMcpServer(testConfig(root, {
    server: {
      transport: "streamable-http",
      port: 0,
      authTokenEnv: TOKEN_ENV,
      allowedOrigins: ["https://chatgpt.com"]
    },
    audit: { enabled: false }
  }));
}

function jsonHeaders(): Record<string, string> {
  return {
    accept: "application/json, text/event-stream",
    "content-type": "application/json"
  };
}

function initializeRequest(): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: {
        name: "secure-mcp-runtime-test",
        version: "0.0.0"
      }
    }
  };
}

async function readMcpResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  const text = await response.text();
  const dataLine = text.split(/\r?\n/).find((line) => line.startsWith("data: "));
  if (!dataLine) {
    throw new Error(`No SSE data line found: ${text}`);
  }
  return JSON.parse(dataLine.slice("data: ".length));
}
