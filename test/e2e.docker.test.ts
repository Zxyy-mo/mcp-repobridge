import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RuntimeConfig } from "../src/config/config.js";
import { inspectSandbox, startSandbox, stopSandbox } from "../src/sandbox/dockerClient.js";
import { sandboxTaskStatus, sandboxTaskTail } from "../src/sandbox/taskRunner.js";
import { execContainerTool } from "../src/tools/execContainer.js";
import { spawnLimited } from "../src/utils/childProcess.js";
import { testConfig } from "./helpers.js";

const RUN_E2E = process.env.RUN_E2E === "1";

describe.skipIf(!RUN_E2E)("docker sandbox e2e", () => {
  let root: string;
  let config: RuntimeConfig;

  beforeAll(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "mcp-repobridge-e2e-")));
    await fs.writeFile(path.join(root, "hello.txt"), "hello from host\n");
    await fs.writeFile(path.join(root, ".env"), "TOP_SECRET=do-not-copy\n");
    await fs.mkdir(path.join(root, ".secure-mcp"));
    await fs.writeFile(path.join(root, ".secure-mcp", "token"), "do-not-copy\n");
    config = testConfig(root, {
      audit: { enabled: false },
      sandbox: {
        containerName: `mcp-repobridge-e2e-${process.pid}`,
        image: "secure-mcp-sandbox:latest",
        timeoutMs: 1500,
        maxOutputBytes: 2048
      }
    });

    await ensureSandboxImage();
    await stopSandbox(config).catch(() => undefined);
    const started = await startSandbox(config);
    expect(started.code).toBe(0);
  }, 180000);

  afterAll(async () => {
    if (config) {
      await stopSandbox(config).catch(() => undefined);
    }
    if (root) {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("runs commands in the mounted workspace as a non-root user", async () => {
    const pwd = await execContainerTool(config, { command: "pwd" });
    const uid = await execContainerTool(config, { command: "id -u" });
    const file = await execContainerTool(config, { command: "cat /workspace/hello.txt" });

    expect(pwd.code).toBe(0);
    expect(pwd.stdout.trim()).toBe("/workspace");
    expect(uid.code).toBe(0);
    expect(uid.stdout.trim()).toBe("1000");
    expect(file.code).toBe(0);
    expect(file.stdout).toBe("hello from host\n");
  });

  it("uses a filtered writable copy without modifying the host workspace", async () => {
    const write = await execContainerTool(config, { command: "printf generated > /workspace/generated.txt" });
    const envHidden = await execContainerTool(config, { command: "test ! -e /workspace/.env" });
    const stateHidden = await execContainerTool(config, { command: "test ! -e /workspace/.secure-mcp" });

    expect(write.code).toBe(0);
    expect(envHidden.code).toBe(0);
    expect(stateHidden.code).toBe(0);
    await expect(fs.stat(path.join(root, "generated.txt"))).rejects.toThrow();
  });

  it("enforces command timeout and output caps", async () => {
    const started = Date.now();
    const sleep = await execContainerTool(config, { command: "sleep 30", timeoutMs: 500, yieldMs: 50 });
    expect(sleep).toMatchObject({ accepted: true, status: "running" });
    const sleepTask = await waitForSandboxTask(config, sleep.taskId);

    const yes = await execContainerTool(config, { command: "yes hello", yieldMs: 50 });
    expect(yes).toMatchObject({ accepted: true, status: "running" });
    const yesTask = await waitForSandboxTask(config, yes.taskId);
    const yesLogs = await sandboxTaskTail(config, { taskId: yes.taskId });

    expect(sleepTask.result?.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(yesTask.result?.truncated).toBe(true);
    expect(Buffer.byteLength(yesLogs.stdout.content)).toBeLessThanOrEqual(config.sandbox.maxOutputBytes);
  });

  it("rejects denied commands before docker exec", async () => {
    await expect(execContainerTool(config, { command: "curl https://example.com" })).rejects.toThrow(/rejected/);
    await expect(execContainerTool(config, { command: "docker ps" })).rejects.toThrow(/rejected/);
    await expect(execContainerTool(config, { command: "rm -rf /" })).rejects.toThrow(/rejected/);
  });

  it("starts the container with the expected Docker hardening", async () => {
    const inspected = await inspectSandbox(config);
    expect(inspected.code).toBe(0);
    const [container] = JSON.parse(inspected.stdout) as Array<{
      HostConfig: {
        NetworkMode: string;
        CapDrop?: string[];
        ReadonlyRootfs: boolean;
        SecurityOpt?: string[];
      };
      Mounts: Array<{ Destination: string; RW: boolean; Source: string }>;
    }>;
    const mounts = JSON.stringify(container.Mounts);
    const workspaceMount = container.Mounts.find((mount) => mount.Destination === "/workspace");

    expect(container.HostConfig.NetworkMode).toBe("none");
    expect(container.HostConfig.CapDrop).toContain("ALL");
    expect(container.HostConfig.ReadonlyRootfs).toBe(true);
    expect(container.HostConfig.SecurityOpt).toContain("no-new-privileges");
    expect(workspaceMount).toMatchObject({ Destination: "/workspace", RW: true });
    expect(workspaceMount?.Source).not.toBe(root);
    expect(mounts).not.toContain("/var/run/docker.sock");
    expect(mounts).not.toContain(".ssh");
  });
});

async function ensureSandboxImage(): Promise<void> {
  const inspected = await spawnLimited("docker", ["image", "inspect", "secure-mcp-sandbox:latest"], {
    timeoutMs: 30000,
    maxOutputBytes: 20000
  });
  if (inspected.code === 0) return;

  const built = await spawnLimited("docker", [
    "build",
    "-f",
    "docker/Dockerfile.sandbox",
    "-t",
    "secure-mcp-sandbox:latest",
    "docker"
  ], {
    timeoutMs: 120000,
    maxOutputBytes: 200000
  });
  expect(built.code, built.stderr || built.stdout).toBe(0);
}

async function waitForSandboxTask(config: RuntimeConfig, taskId: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { task } = await sandboxTaskStatus(config, taskId);
    if (task.status !== "running") return task;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for sandbox task ${taskId}`);
}
