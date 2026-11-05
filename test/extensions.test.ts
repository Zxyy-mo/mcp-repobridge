import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../src/config/config.js";
import { StructuredToolError } from "../src/policy/errors.js";
import {
  callDiscoveredMcpTool,
  discoverMcpServer,
  listConfiguredMcpServers
} from "../src/extensions/mcpProxy.js";
import {
  describeDocumentSkill,
  listDocumentSkills,
  readDocumentSkill
} from "../src/extensions/skills.js";
import { workspaceInfoTool } from "../src/tools/workspaceInfo.js";
import { mcpCallTool } from "../src/tools/extensions.js";
import { testConfig } from "./helpers.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  delete process.env.REPOBRIDGE_EXTENSION_TEST_SOURCE;
  delete process.env.REPOBRIDGE_EXTENSION_TEST_SECRET;
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("document Skill gateway", () => {
  it("discovers and revision-binds Markdown instructions without an execution surface", async () => {
    const root = await temporaryRoot();
    const skillDirectory = path.join(root, "skills", "review");
    await fs.mkdir(skillDirectory, { recursive: true });
    await fs.writeFile(path.join(skillDirectory, "SKILL.md"), [
      "---",
      "name: safe-review",
      "description: Review without executing scripts",
      "---",
      "# Instructions",
      "Read the diff."
    ].join("\n"));
    const config = extensionConfig(root, { skillDirs: ["skills"] });

    const listed = await listDocumentSkills(config);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      name: "safe-review",
      runtime: "markdown",
      execution: "none",
      contentTrust: "untrusted-instructions",
      scope: "workspace"
    });
    const described = await describeDocumentSkill(config, "safe-review");
    expect(described.invocation.arguments).toEqual({ name: "safe-review", revision: listed[0].revision });
    const read = await readDocumentSkill(config, {
      name: "safe-review",
      revision: listed[0].revision,
      limit: 4096
    });
    expect(read.content).toContain("Read the diff.");
    expect(read.truncated).toBe(false);

    await fs.appendFile(path.join(skillDirectory, "SKILL.md"), "\nChanged.");
    await expect(readDocumentSkill(config, {
      name: "safe-review",
      revision: listed[0].revision
    })).rejects.toMatchObject<Partial<StructuredToolError>>({ toolCode: "SKILL_DISCOVERY_STALE" });
  });

  it("does not follow a Skill file symlink outside the configured root", async () => {
    const root = await temporaryRoot();
    const skillDirectory = path.join(root, "skills", "linked");
    const outside = path.join(root, "outside-secret.txt");
    await fs.mkdir(skillDirectory, { recursive: true });
    await fs.writeFile(outside, "must-not-be-returned");
    await fs.symlink(outside, path.join(skillDirectory, "SKILL.md"));

    const listed = await listDocumentSkills(extensionConfig(root, { skillDirs: ["skills"] }));
    expect(listed).toEqual([]);
    expect(JSON.stringify(listed)).not.toContain("must-not-be-returned");
  });

  it("rejects a relative Skill root that is redirected outside the workspace", async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await fs.mkdir(path.join(outside, "redirected"), { recursive: true });
    await fs.writeFile(path.join(outside, "redirected", "SKILL.md"), "outside");
    await fs.symlink(outside, path.join(root, "skills"));

    await expect(listDocumentSkills(extensionConfig(root, { skillDirs: ["skills"] })))
      .rejects.toMatchObject<Partial<StructuredToolError>>({ toolCode: "SKILL_ROOT_ESCAPE" });
  });
});

describe("trusted host MCP gateway", () => {
  it("discovers only allowlisted tools and calls them through a revision lease", async () => {
    const root = await temporaryRoot();
    const fakeServer = await writeFakeMcpServer(root);
    const config = extensionConfig(root, {
      hostMcpEnabled: true,
      safeEnvKeys: ["PATH"],
      mcpServers: [{
        name: "fake",
        description: "test server",
        enabled: true,
        command: process.execPath,
        args: [fakeServer],
        allowedTools: ["echo", "environment"],
        envFromHost: { VISIBLE_VALUE: "REPOBRIDGE_EXTENSION_TEST_SOURCE" }
      }]
    });
    process.env.REPOBRIDGE_EXTENSION_TEST_SOURCE = "mapped-value";
    process.env.REPOBRIDGE_EXTENSION_TEST_SECRET = "must-not-leak";

    const safeList = listConfiguredMcpServers(config);
    expect(safeList).toEqual([expect.objectContaining({ name: "fake", state: "available", allowedTools: 2 })]);
    expect(JSON.stringify(safeList)).not.toContain(process.execPath);
    expect(JSON.stringify(safeList)).not.toContain("REPOBRIDGE_EXTENSION_TEST_SOURCE");

    const discovery = await discoverMcpServer(config, "fake");
    expect(discovery.server.tools.map((tool) => tool.name)).toEqual(["echo", "environment"]);
    expect(discovery.server.tools[0].metadataTrust).toBe("untrusted-upstream-metadata");
    expect(discovery.server.tools.map((tool) => tool.name)).not.toContain("hidden");
    expect(JSON.stringify(discovery)).not.toContain(process.execPath);

    const echo = await callDiscoveredMcpTool(config, {
      server: "fake",
      tool: "echo",
      arguments: { text: "hello" },
      discoveryId: discovery.discoveryId,
      discoveryRevision: discovery.discoveryRevision
    });
    expect(echo.upstream.content).toEqual([{ type: "text", text: "hello" }]);
    expect(echo.contentTrust).toBe("untrusted-upstream-output");

    const environment = await callDiscoveredMcpTool(config, {
      server: "fake",
      tool: "environment",
      arguments: {},
      discoveryId: discovery.discoveryId,
      discoveryRevision: discovery.discoveryRevision
    });
    const visibleEnvironment = JSON.parse((environment.upstream.content[0] as { text: string }).text) as Record<string, string | null>;
    expect(visibleEnvironment.VISIBLE_VALUE).toBe("mapped-value");
    expect(visibleEnvironment.REPOBRIDGE_EXTENSION_TEST_SECRET).toBeNull();

    await expect(callDiscoveredMcpTool(config, {
      server: "fake",
      tool: "hidden",
      arguments: {},
      discoveryId: discovery.discoveryId,
      discoveryRevision: discovery.discoveryRevision
    })).rejects.toMatchObject<Partial<StructuredToolError>>({ toolCode: "MCP_DISCOVERY_STALE" });
    await expect(callDiscoveredMcpTool(config, {
      server: "fake",
      tool: "echo",
      arguments: {},
      discoveryId: discovery.discoveryId,
      discoveryRevision: `${discovery.discoveryRevision}-tampered`
    })).rejects.toMatchObject<Partial<StructuredToolError>>({ toolCode: "MCP_DISCOVERY_STALE" });

    const auditedConfig = { ...config, audit: { enabled: true, path: ".secure-mcp/audit.log" } };
    await mcpCallTool(auditedConfig, {
      server: "fake",
      tool: "echo",
      arguments: { text: "sensitive-upstream-argument" },
      discoveryId: discovery.discoveryId,
      discoveryRevision: discovery.discoveryRevision
    });
    const audit = await fs.readFile(path.join(root, ".secure-mcp", "audit.log"), "utf8");
    expect(audit).toContain('"argumentKeys":["text"]');
    expect(audit).not.toContain("sensitive-upstream-argument");
  });

  it("caps concurrent host MCP child processes", async () => {
    const root = await temporaryRoot();
    const fakeServer = await writeFakeMcpServer(root);
    const config = extensionConfig(root, {
      hostMcpEnabled: true,
      maxConcurrentMcpProcesses: 1,
      mcpServers: [{
        name: "limited",
        enabled: true,
        command: process.execPath,
        args: [fakeServer],
        allowedTools: ["echo", "wait"],
        envFromHost: {}
      }]
    });
    const discovery = await discoverMcpServer(config, "limited");
    const first = callDiscoveredMcpTool(config, {
      server: "limited",
      tool: "wait",
      arguments: {},
      discoveryId: discovery.discoveryId,
      discoveryRevision: discovery.discoveryRevision
    });
    await expect(callDiscoveredMcpTool(config, {
      server: "limited",
      tool: "echo",
      arguments: {},
      discoveryId: discovery.discoveryId,
      discoveryRevision: discovery.discoveryRevision
    })).rejects.toMatchObject<Partial<StructuredToolError>>({ toolCode: "MCP_PROCESS_LIMIT_REACHED" });
    await expect(first).resolves.toMatchObject({ tool: "wait" });
  });

  it("lists trusted configuration but cannot spawn it while host execution is disabled", async () => {
    const root = await temporaryRoot();
    const config = extensionConfig(root, {
      mcpServers: [{
        name: "disabled-host",
        enabled: true,
        command: process.execPath,
        args: ["should-never-run.mjs"],
        allowedTools: ["echo"],
        envFromHost: {}
      }]
    });

    expect(listConfiguredMcpServers(config)[0].state).toBe("host_execution_disabled");
    await expect(discoverMcpServer(config, "disabled-host"))
      .rejects.toMatchObject<Partial<StructuredToolError>>({ toolCode: "HOST_MCP_DISABLED" });
  });

  it("does not expose configured commands or environment mappings in workspace info", async () => {
    const root = await temporaryRoot();
    const config = extensionConfig(root, {
      hostMcpEnabled: true,
      mcpServers: [{
        name: "private-config",
        enabled: true,
        command: "/private/trusted/server",
        args: ["--private-argument"],
        allowedTools: ["one"],
        envFromHost: { TARGET_SECRET: "SOURCE_SECRET" }
      }]
    });

    const result = await workspaceInfoTool(config);
    const serialized = JSON.stringify(result);
    expect(serialized).toContain("private-config");
    expect(serialized).not.toContain("/private/trusted/server");
    expect(serialized).not.toContain("--private-argument");
    expect(serialized).not.toContain("TARGET_SECRET");
    expect(serialized).not.toContain("SOURCE_SECRET");
  });

  it("rejects wildcard upstream tool access in trusted configuration", () => {
    const config = extensionConfig(process.cwd(), {
      hostMcpEnabled: true,
      mcpServers: [{
        name: "too-broad",
        enabled: true,
        command: process.execPath,
        args: [],
        allowedTools: ["*"],
        envFromHost: {}
      }]
    });

    expect(() => ConfigSchema.parse(config)).toThrow(/Wildcard MCP tool access is not supported/);
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-repobridge-extensions-"));
  temporaryRoots.push(root);
  return root;
}

function extensionConfig(
  root: string,
  overrides: Partial<ReturnType<typeof testConfig>["extensions"]> = {}
) {
  return testConfig(root, {
    audit: { enabled: false },
    extensions: {
      enabled: true,
      hostMcpEnabled: false,
      ...overrides
    }
  });
}

async function writeFakeMcpServer(root: string): Promise<string> {
  const serverPath = path.join(root, "fake-mcp.mjs");
  await fs.writeFile(serverPath, String.raw`
let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  while (buffered.includes("\n")) {
    const newline = buffered.indexOf("\n");
    const line = buffered.slice(0, newline).replace(/\r$/, "");
    buffered = buffered.slice(newline + 1);
    if (line) handle(JSON.parse(line));
  }
});

function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function handle(request) {
  if (request.method === "initialize") {
    send(request.id, {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "fake-extension-server", version: "1.0.0" }
    });
    return;
  }
  if (request.method === "tools/list") {
    send(request.id, { tools: [
      { name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
      { name: "environment", description: "Show test env", inputSchema: { type: "object", properties: {} } },
      { name: "wait", description: "Wait briefly", inputSchema: { type: "object", properties: {} } },
      { name: "hidden", description: "Must be filtered", inputSchema: { type: "object", properties: {} } }
    ] });
    return;
  }
  if (request.method === "tools/call") {
    if (request.params.name === "echo") {
      send(request.id, { content: [{ type: "text", text: String(request.params.arguments?.text ?? "") }] });
      return;
    }
    if (request.params.name === "environment") {
      send(request.id, { content: [{ type: "text", text: JSON.stringify({
        VISIBLE_VALUE: process.env.VISIBLE_VALUE ?? null,
        REPOBRIDGE_EXTENSION_TEST_SECRET: process.env.REPOBRIDGE_EXTENSION_TEST_SECRET ?? null
      }) }] });
      return;
    }
    if (request.params.name === "wait") {
      setTimeout(() => send(request.id, { content: [{ type: "text", text: "waited" }] }), 100);
      return;
    }
    send(request.id, { isError: true, content: [{ type: "text", text: "unknown" }] });
  }
}
`);
  return serverPath;
}
