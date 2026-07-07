import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findFilesTool } from "../src/tools/findFiles.js";
import { grepFilesTool } from "../src/tools/grepFiles.js";
import { listDirectoryTool } from "../src/tools/listDirectory.js";
import { readFileTool } from "../src/tools/readFile.js";
import { workspaceInfoTool } from "../src/tools/workspaceInfo.js";
import { auditLogTailTool } from "../src/tools/auditLogTail.js";
import { testConfig } from "./helpers.js";

describe("file tools", () => {
  it("read_file reads byte ranges and truncates at the configured cap", async () => {
    const root = await makeWorkspace();
    await fs.writeFile(path.join(root, "file.txt"), "abcdef");
    const config = testConfig(root, { workspace: { maxReadBytes: 3 } });

    await expect(readFileTool(config, { path: "file.txt", offset: 1, limit: 2 })).resolves.toMatchObject({
      content: "bc",
      truncated: true,
      bytesRead: 2
    });
    await expect(readFileTool(config, { path: "file.txt", limit: 100 })).resolves.toMatchObject({
      content: "abc",
      truncated: true,
      bytesRead: 3
    });
  });

  it("list_directory caps results and filters secret-like entries", async () => {
    const root = await makeWorkspace();
    await fs.writeFile(path.join(root, "a.txt"), "a");
    await fs.writeFile(path.join(root, "b.txt"), "b");
    await fs.writeFile(path.join(root, ".env"), "secret");
    const config = testConfig(root, { workspace: { maxDirectoryEntries: 1 } });

    const result = await listDirectoryTool(config, { path: "." });
    expect(result.entries).toHaveLength(1);
    expect(result.entries.map((entry) => entry.name)).not.toContain(".env");
    expect(result.truncated).toBe(true);
  });

  it("grep_files searches inside workspace and applies default excludes", async () => {
    const root = await makeWorkspace();
    await fs.mkdir(path.join(root, "src"));
    await fs.mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "app.ts"), "const value = 'needle';\n");
    await fs.writeFile(path.join(root, "node_modules", "pkg", "ignored.ts"), "needle\n");
    await fs.writeFile(path.join(root, ".env"), "needle\n");
    const config = testConfig(root);

    const result = await grepFilesTool(config, { pattern: "needle", path: ".", maxMatches: 10 });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ path: "src/app.ts", line: 1 });
  });

  it("find_files caps result count and rejects unsafe globs", async () => {
    const root = await makeWorkspace();
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "src", "a.ts"), "a");
    await fs.writeFile(path.join(root, "src", "b.ts"), "b");
    const config = testConfig(root);

    const result = await findFilesTool(config, { pattern: "src/*.ts", maxResults: 1 });
    expect(result.results).toHaveLength(1);
    expect(result.truncated).toBe(true);
    await expect(findFilesTool(config, { pattern: "../*.ts" })).rejects.toThrow(/Unsafe glob/);
  });

  it("records audit entries for tool calls", async () => {
    const root = await makeWorkspace();
    await fs.writeFile(path.join(root, "file.txt"), "ok");
    const config = testConfig(root);

    await readFileTool(config, { path: "file.txt" });
    await expect(readFileTool(config, { path: ".env" })).rejects.toThrow();

    const auditText = await fs.readFile(path.join(root, ".secure-mcp", "audit.log"), "utf8");
    const records = auditText.trim().split("\n").map((line) => JSON.parse(line) as { tool: string; action: string });
    expect(records).toMatchObject([
      { tool: "read_file", action: "allow" },
      { tool: "read_file", action: "deny" }
    ]);
  });

  it("workspace_info returns runtime summary without auth token values", async () => {
    const root = await makeWorkspace();
    const config = testConfig(root, { server: { authTokenEnv: "SECRET_TOKEN_ENV" } });

    const result = await workspaceInfoTool(config);
    const text = JSON.stringify(result);
    expect(result.workspaceRoot).toBe(root);
    expect(result.sandbox.containerName).toBe(config.sandbox.containerName);
    expect(text).not.toContain("SECRET_TOKEN_ENV");
  });

  it("audit_log_tail caps records from the fixed audit log", async () => {
    const root = await makeWorkspace();
    const config = testConfig(root, { audit: { enabled: false } });
    await fs.mkdir(path.join(root, ".secure-mcp"), { recursive: true });
    await fs.writeFile(path.join(root, ".secure-mcp", "audit.log"), [
      JSON.stringify({ tool: "one" }),
      JSON.stringify({ tool: "two" }),
      JSON.stringify({ tool: "three" })
    ].join("\n"));

    const result = await auditLogTailTool(config, { lines: 2 });
    expect(result.records).toEqual([{ tool: "two" }, { tool: "three" }]);
    expect(result.truncated).toBe(true);
  });
});

async function makeWorkspace(): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "secure-mcp-tools-")));
}
