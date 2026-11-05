import type { RuntimeConfig } from "../config/config.js";
import { auditToolCall } from "../audit/auditLog.js";
import {
  callDiscoveredMcpTool,
  discoverMcpServer,
  listConfiguredMcpServers
} from "../extensions/mcpProxy.js";
import {
  describeDocumentSkill,
  listDocumentSkills,
  readDocumentSkill
} from "../extensions/skills.js";

export async function extensionDiscoverTool(
  config: RuntimeConfig,
  input: { kind: "skill" | "mcp"; name?: string; query?: string }
) {
  return auditToolCall(config, "extension_discover", {
    kind: input.kind,
    name: input.name,
    hasQuery: Boolean(input.query)
  }, async () => {
    if (input.kind === "skill") {
      if (input.name) {
        const skill = await describeDocumentSkill(config, input.name);
        return {
          kind: "skill" as const,
          view: "describe" as const,
          skill,
          nextAction: skill.invocation
        };
      }
      const skills = await listDocumentSkills(config, { query: input.query });
      return {
        kind: "skill" as const,
        view: "list" as const,
        count: skills.length,
        skills: skills.map((skill) => ({
          ...skill,
          discoveryAction: {
            tool: "extension_discover",
            arguments: { kind: "skill", name: skill.name },
            reason: "Describe this configured Skill and obtain an exact skill_read invocation."
          }
        }))
      };
    }
    if (input.name) {
      return {
        kind: "mcp" as const,
        view: "describe" as const,
        ...await discoverMcpServer(config, input.name)
      };
    }
    const servers = listConfiguredMcpServers(config, input.query);
    return {
      kind: "mcp" as const,
      view: "list" as const,
      count: servers.length,
      servers: servers.map((server) => ({
        ...server,
        discoveryAction: {
          tool: "extension_discover",
          arguments: { kind: "mcp", name: server.name },
          reason: "Start only this trusted configured MCP server and discover its allowlisted tool schemas."
        }
      }))
    };
  });
}

export async function skillReadTool(
  config: RuntimeConfig,
  input: { name: string; revision: string; offset?: number; limit?: number }
) {
  return auditToolCall(config, "skill_read", {
    name: input.name,
    revision: input.revision,
    offset: input.offset,
    limit: input.limit
  }, () => readDocumentSkill(config, input), (result) => ({
    stdoutBytes: result.bytesRead
  }));
}

export async function mcpCallTool(
  config: RuntimeConfig,
  input: {
    server: string;
    tool: string;
    arguments?: Record<string, unknown>;
    discoveryId: string;
    discoveryRevision: string;
  }
) {
  return auditToolCall(config, "mcp_call", {
    server: input.server,
    upstreamTool: input.tool,
    discoveryId: input.discoveryId,
    argumentKeys: Object.keys(input.arguments ?? {}).sort()
  }, () => callDiscoveredMcpTool(config, input), (result) => ({
    stdoutBytes: result.resultBytes
  }));
}
