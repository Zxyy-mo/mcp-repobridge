import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildDockerRunArgs } from "../src/sandbox/dockerArgs.js";
import { execContainerTool, resolveContainerWorkdir } from "../src/tools/execContainer.js";
import { testConfig } from "./helpers.js";

describe("docker sandbox policy", () => {
  it("builds docker run args with fixed security defaults", () => {
    const config = testConfig("/workspace-host");
    const args = buildDockerRunArgs(config);
    const joined = args.join(" ");

    expect(args).toContain("--name");
    expect(args).toContain(config.sandbox.containerName);
    expect(args).toContain("--network");
    expect(args).toContain("none");
    expect(args).toContain("--cap-drop=ALL");
    expect(args).toContain("no-new-privileges");
    expect(args).toContain("--read-only");
    expect(args).toContain("--memory");
    expect(args).toContain(config.sandbox.memory);
    expect(args).toContain("--cpus");
    expect(args).toContain(config.sandbox.cpus);
    expect(args).toContain("--pids-limit");
    expect(args).toContain(String(config.sandbox.pidsLimit));
    expect(joined).not.toContain("/var/run/docker.sock");
    expect(joined).not.toContain(`${os.homedir()}:`);
    expect(joined).not.toContain(".ssh");
  });

  it("keeps container workdir inside the configured workspace path", () => {
    expect(resolveContainerWorkdir("/workspace", undefined)).toBe("/workspace");
    expect(resolveContainerWorkdir("/workspace", "packages/app")).toBe("/workspace/packages/app");
    expect(() => resolveContainerWorkdir("/workspace", "..")).toThrow(/escapes/);
    expect(() => resolveContainerWorkdir("/workspace", "/tmp")).toThrow(/escapes/);
  });

  it("rejects denied commands before docker execution and records audit", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "secure-mcp-exec-")));
    const config = testConfig(root);

    await expect(execContainerTool(config, { command: "curl https://example.com" })).rejects.toThrow(/rejected/);

    const auditText = await fs.readFile(path.join(root, ".secure-mcp", "audit.log"), "utf8");
    const record = JSON.parse(auditText.trim()) as { tool: string; action: string; summary: { commandPreview: string } };
    expect(record.tool).toBe("exec_container");
    expect(record.action).toBe("deny");
    expect(record.summary.commandPreview).toContain("curl");
  });
});
