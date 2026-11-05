import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CODEX_HANDOFF_TOOL_NAMES,
  EXTENSION_TOOL_NAMES,
  HOST_MCP_TOOL_NAMES,
  REGISTERED_TOOL_NAMES,
  registeredToolNamesForConfig,
  registerSecureTools
} from "../src/server/mcpServer.js";
import { testConfig } from "./helpers.js";

describe("tool exposure", () => {
  it("registered tool list includes only the v1 surface", () => {
    const config = testConfig(process.cwd(), { audit: { enabled: false } });
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerSecureTools(server, config);

    const registeredToolNames = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools).sort();
    expect(registeredToolNames).toEqual([...REGISTERED_TOOL_NAMES].sort());
    expect(registeredToolNames).toEqual(registeredToolNamesForConfig(config).sort());
    expect(registeredToolNames).toContain("read_file");
    expect(registeredToolNames).toContain("read_files");
    expect(registeredToolNames).toContain("list_directory");
    expect(registeredToolNames).toContain("grep_files");
    expect(registeredToolNames).toContain("find_files");
    expect(registeredToolNames).toContain("project_task_list");
    expect(registeredToolNames).toContain("project_task_run");
    expect(registeredToolNames).toContain("exec_container");
    expect(registeredToolNames).toContain("sandbox_status");
    expect(registeredToolNames).toContain("sandbox_task_status");
    expect(registeredToolNames).toContain("sandbox_task_tail");
    expect(registeredToolNames).toContain("sandbox_task_cancel");
    expect(registeredToolNames).toContain("workspace_bootstrap");
    expect(registeredToolNames).not.toContain("run_shell");
    expect(registeredToolNames).not.toContain("host_exec");
    expect(registeredToolNames).not.toContain("write_file");
    expect(registeredToolNames).not.toContain("edit_file");
    expect(registeredToolNames.some((name) => name.includes("docker"))).toBe(false);
  });

  it("adds Codex handoff tools only when explicitly enabled", () => {
    const config = testConfig(process.cwd(), {
      audit: { enabled: false },
      codexHandoff: { enabled: true }
    });
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerSecureTools(server, config);

    const registeredToolNames = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools).sort();
    expect(registeredToolNames).toEqual(registeredToolNamesForConfig(config).sort());
    for (const toolName of CODEX_HANDOFF_TOOL_NAMES) {
      expect(registeredToolNames).toContain(toolName);
    }
    expect(registeredToolNames).not.toContain("write_file");
    expect(registeredToolNames).not.toContain("edit_file");
    expect(registeredToolNames).not.toContain("run_shell");
    expect(registeredToolNames).not.toContain("host_exec");
  });

  it("adds document Skills and host MCP calls only at their separate trust gates", () => {
    const skillsOnly = testConfig(process.cwd(), {
      audit: { enabled: false },
      extensions: { enabled: true, hostMcpEnabled: false }
    });
    expect(registeredToolNamesForConfig(skillsOnly)).toEqual([
      ...REGISTERED_TOOL_NAMES,
      ...EXTENSION_TOOL_NAMES
    ]);
    expect(registeredToolNamesForConfig(skillsOnly)).not.toContain("mcp_call");

    const hostMcp = testConfig(process.cwd(), {
      audit: { enabled: false },
      extensions: { enabled: true, hostMcpEnabled: true }
    });
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerSecureTools(server, hostMcp);
    const names = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
    for (const toolName of [...EXTENSION_TOOL_NAMES, ...HOST_MCP_TOOL_NAMES]) {
      expect(names).toContain(toolName);
    }
  });
});
