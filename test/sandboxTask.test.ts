import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSandboxTask,
  readSandboxTask,
  readSandboxTaskLogs,
  sandboxTaskLogPaths,
  writeSandboxTask
} from "../src/sandbox/taskStore.js";
import { testConfig } from "./helpers.js";

describe("sandbox task store", () => {
  it("persists task state and reads logs incrementally", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-task-store-")));
    const config = testConfig(root, { audit: { enabled: false } });
    const task = await createSandboxTask(config, {
      command: "npm test",
      workdir: "/workspace",
      timeoutMs: 1000
    });
    const logs = await sandboxTaskLogPaths(config, task.id);
    await fs.appendFile(logs.stdout, "first\nsecond\n");
    await fs.appendFile(logs.stderr, "warning\n");

    const first = await readSandboxTaskLogs(config, task.id, { maxBytes: 6 });
    const second = await readSandboxTaskLogs(config, task.id, {
      stdoutOffset: first.stdout.nextOffset,
      stderrOffset: first.stderr.nextOffset,
      maxBytes: 20
    });

    expect(first.stdout).toMatchObject({ content: "first\n", offset: 0, nextOffset: 6, truncated: true });
    expect(second.stdout.content).toBe("second\n");
    expect(first.stderr.content).toBe("warnin");
    expect(second.stderr.content).toBe("g\n");

    const finished = {
      ...task,
      status: "succeeded" as const,
      updatedAt: new Date().toISOString(),
      result: {
        finishedAt: new Date().toISOString(),
        exitCode: 0,
        signal: null,
        timedOut: false,
        truncated: false,
        stdoutBytes: 13,
        stderrBytes: 8
      }
    };
    await writeSandboxTask(config, finished);
    await expect(readSandboxTask(config, task.id)).resolves.toMatchObject({ status: "succeeded" });
  });

  it("rejects a task directory symlink that escapes the workspace", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-task-root-")));
    const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-task-outside-")));
    await fs.mkdir(path.join(root, ".secure-mcp"), { recursive: true });
    await fs.symlink(outside, path.join(root, ".secure-mcp", "sandbox-tasks"));
    const config = testConfig(root, { audit: { enabled: false } });

    await expect(createSandboxTask(config, {
      command: "pwd",
      workdir: "/workspace",
      timeoutMs: 1000
    })).rejects.toThrow(/escapes workspace/);
  });

  it("does not follow a replaced task log symlink", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-task-log-root-")));
    const outside = path.join(await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-task-log-outside-"))), "secret.txt");
    await fs.writeFile(outside, "host secret\n");
    const config = testConfig(root, { audit: { enabled: false } });
    const task = await createSandboxTask(config, {
      command: "pwd",
      workdir: "/workspace",
      timeoutMs: 1000
    });
    const logs = await sandboxTaskLogPaths(config, task.id);
    await fs.rm(logs.stdout);
    await fs.symlink(outside, logs.stdout);

    await expect(readSandboxTaskLogs(config, task.id)).rejects.toThrow();
  });
});
