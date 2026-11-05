import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  codexTaskCancelTool,
  codexTaskCreateTool,
  codexTaskListTool,
  codexTaskStatusTool,
  codexTaskTailTool
} from "../src/tools/codexTasks.js";
import { readCodexTask } from "../src/codexHandoff/taskStore.js";
import { processNextCodexTask } from "../src/codexHandoff/worker.js";
import { listWorkerHeartbeats } from "../src/codexHandoff/workerHeartbeat.js";
import { testConfig } from "./helpers.js";

describe("Codex handoff", () => {
  it("is disabled by default", async () => {
    const root = await makeWorkspace();
    const config = testConfig(root, { audit: { enabled: false } });

    await expect(codexTaskCreateTool(config, {
      title: "Implement feature",
      prompt: "Change the code."
    })).rejects.toThrow(/disabled/);
  });

  it("creates, lists, reads, tails, and cancels queued tasks", async () => {
    const root = await makeWorkspace();
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "src", "app.ts"), "export const value = 1;\n");
    const config = testConfig(root, {
      audit: { enabled: false },
      codexHandoff: { enabled: true }
    });

    const created = await codexTaskCreateTool(config, {
      title: "Update app",
      prompt: "Change value to 2.",
      relevantFiles: ["src/app.ts"],
      acceptanceCriteria: ["value is updated"],
      priority: "high"
    });

    expect(created.task.status).toBe("queued");
    expect(created.task.prompt).toBeUndefined();
    expect(created.task.promptPreview).toContain("Change value");
    expect(created.task.relevantFiles).toEqual(["src/app.ts"]);
    expect(created.task.baseline.relevantFiles[0]).toMatchObject({
      path: "src/app.ts",
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    });

    const listed = await codexTaskListTool(config);
    expect(listed.count).toBe(1);
    expect(listed.tasks[0].id).toBe(created.task.id);

    const status = await codexTaskStatusTool(config, { taskId: created.task.id, includePrompt: true });
    expect(status.task.prompt).toBe("Change value to 2.");

    const tail = await codexTaskTailTool(config, { taskId: created.task.id });
    expect(tail.content).toBe("");

    const canceled = await codexTaskCancelTool(config, { taskId: created.task.id, reason: "superseded" });
    expect(canceled.task.status).toBe("canceled");
    expect((await readCodexTask(config, created.task.id)).cancellation?.reason).toBe("superseded");
  });

  it("deduplicates retries with an idempotency key and rejects conflicting reuse", async () => {
    const root = await makeWorkspace();
    const config = testConfig(root, {
      audit: { enabled: false },
      codexHandoff: { enabled: true }
    });
    const request = {
      title: "Idempotent task",
      prompt: "Do this exactly once.",
      idempotencyKey: "request-123"
    };

    const first = await codexTaskCreateTool(config, request);
    const second = await codexTaskCreateTool(config, request);

    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.task.id).toBe(first.task.id);
    await expect(codexTaskCreateTool(config, { ...request, prompt: "Different request." }))
      .rejects.toThrow(/conflicts/);
  });

  it("blocks secret-like relevant files", async () => {
    const root = await makeWorkspace();
    await fs.writeFile(path.join(root, ".env"), "SECRET=1\n");
    const config = testConfig(root, {
      audit: { enabled: false },
      codexHandoff: { enabled: true }
    });

    await expect(codexTaskCreateTool(config, {
      title: "Read env",
      prompt: "Use the env file.",
      relevantFiles: [".env"]
    })).rejects.toThrow(/Secret-like/);
  });

  it("rejects queue directory symlink escapes", async () => {
    const root = await makeWorkspace();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "secure-mcp-codex-outside-"));
    await fs.mkdir(path.join(root, ".secure-mcp", "codex-tasks"), { recursive: true });
    await fs.symlink(outside, path.join(root, ".secure-mcp", "codex-tasks", "logs"));
    const config = testConfig(root, {
      audit: { enabled: false },
      codexHandoff: { enabled: true }
    });

    await expect(codexTaskCreateTool(config, {
      title: "Symlink escape",
      prompt: "This should not create a task."
    })).rejects.toThrow(/realpath escapes/);
  });

  it("does not follow a replaced Codex log symlink", async () => {
    const root = await makeWorkspace();
    const outside = path.join(await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "secure-mcp-codex-log-"))), "secret.txt");
    await fs.writeFile(outside, "host secret\n");
    const config = testConfig(root, {
      audit: { enabled: false },
      codexHandoff: { enabled: true }
    });
    const created = await codexTaskCreateTool(config, {
      title: "Log safety",
      prompt: "Do not run this task."
    });
    const logPath = path.join(root, config.codexHandoff.queuePath, "logs", `${created.task.id}.log`);
    await fs.symlink(outside, logPath);

    await expect(codexTaskTailTool(config, { taskId: created.task.id })).rejects.toThrow();
  });

  it("lets a local worker claim and execute a queued task", async () => {
    const root = await makeWorkspace();
    const workerScript = [
      "let input = '';",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  console.log(JSON.stringify({",
      "    hasTitle: input.includes('Title: Worker task'),",
      "    hasPrompt: input.includes('Task prompt:') && input.includes('Do the worker job.')",
      "  }));",
      "});"
    ].join("");
    const config = testConfig(root, {
      audit: { enabled: false },
      codexHandoff: {
        enabled: true,
        codexCommand: process.execPath,
        codexArgs: ["-e", workerScript],
        taskTimeoutMs: 5000,
        maxResultBytes: 4096
      }
    });

    const created = await codexTaskCreateTool(config, {
      title: "Worker task",
      prompt: "Do the worker job."
    });
    const processed = await processNextCodexTask(config, { workerId: "test-worker" });
    const task = await readCodexTask(config, created.task.id);

    expect(processed).toMatchObject({ processed: true, taskId: created.task.id, status: "succeeded" });
    expect(task.status).toBe("succeeded");
    expect(task.worker?.workerId).toBe("test-worker");
    expect(task.result?.stdoutTail).toContain('"hasTitle":true');
    expect(task.result?.stdoutTail).toContain('"hasPrompt":true');
    expect(task.result).toMatchObject({ canceled: false, changedFiles: [], preexistingChanges: [] });
    const heartbeat = await listWorkerHeartbeats(config);
    expect(heartbeat).toMatchObject({
      online: true,
      workers: [expect.objectContaining({ workerId: "test-worker", status: "idle", online: true })]
    });

    const tail = await codexTaskTailTool(config, { taskId: created.task.id });
    expect(tail.content).toContain("STDOUT:");
    expect(tail.content).toContain('"hasPrompt":true');
    const firstLogPage = await codexTaskTailTool(config, { taskId: created.task.id, offset: 0, bytes: 20 });
    const secondLogPage = await codexTaskTailTool(config, {
      taskId: created.task.id,
      offset: firstLogPage.nextOffset,
      bytes: 20
    });
    expect(firstLogPage.offset).toBe(0);
    expect(firstLogPage.truncated).toBe(true);
    expect(secondLogPage.offset).toBe(firstLogPage.nextOffset);
  });

  it("fails safely before worker execution when relevant file context drifted", async () => {
    const root = await makeWorkspace();
    await fs.writeFile(path.join(root, "app.ts"), "export const value = 1;\n");
    const config = testConfig(root, {
      audit: { enabled: false },
      codexHandoff: {
        enabled: true,
        codexCommand: process.execPath,
        codexArgs: ["-e", "console.log('should-not-run')"]
      }
    });
    const created = await codexTaskCreateTool(config, {
      title: "Drifted task",
      prompt: "Update app.",
      relevantFiles: ["app.ts"]
    });
    await fs.writeFile(path.join(root, "app.ts"), "export const value = 2;\n");

    const processed = await processNextCodexTask(config, { workerId: "drift-worker" });
    const task = await readCodexTask(config, created.task.id);

    expect(processed.status).toBe("failed");
    expect(task.result?.contextDrift).toEqual([
      expect.objectContaining({ path: "app.ts", reason: "content_changed" })
    ]);
    expect(task.result?.stdoutTail).not.toContain("should-not-run");
  });

  it("cooperatively cancels a running local worker task", async () => {
    const root = await makeWorkspace();
    const config = testConfig(root, {
      audit: { enabled: false },
      codexHandoff: {
        enabled: true,
        codexCommand: process.execPath,
        codexArgs: ["-e", "setInterval(() => {}, 1000)"],
        cancellationPollIntervalMs: 20,
        taskTimeoutMs: 5000
      }
    });
    const created = await codexTaskCreateTool(config, {
      title: "Cancelable task",
      prompt: "Wait until canceled."
    });
    const processing = processNextCodexTask(config, { workerId: "cancel-worker" });
    await waitFor(async () => (await readCodexTask(config, created.task.id)).status === "running");

    const cancellation = await codexTaskCancelTool(config, {
      taskId: created.task.id,
      reason: "user requested"
    });
    const processed = await processing;
    const task = await readCodexTask(config, created.task.id);

    expect(cancellation.task.cancellation?.reason).toBe("user requested");
    expect(processed.status).toBe("canceled");
    expect(task).toMatchObject({ status: "canceled", result: { canceled: true } });
  });

  it("does not pass host secret-like environment variables to the worker child", async () => {
    const root = await makeWorkspace();
    const previousEnv = saveEnv([
      "MOCK_AWS_SECRET_KEY",
      "GH_TOKEN",
      "CODEX_TOKEN",
      "SSH_AUTH_SOCK",
      "CODEX_HOME",
      "CUSTOM_ALLOWED"
    ]);
    process.env.MOCK_AWS_SECRET_KEY = "do-not-leak";
    process.env.GH_TOKEN = "do-not-leak";
    process.env.CODEX_TOKEN = "do-not-leak";
    process.env.SSH_AUTH_SOCK = "/tmp/ssh-agent.sock";
    process.env.CODEX_HOME = "/tmp/codex-home";
    process.env.CUSTOM_ALLOWED = "visible";

    try {
      const workerScript = [
        "console.log(JSON.stringify({",
        "  hasPath: Boolean(process.env.PATH),",
        "  codexHome: process.env.CODEX_HOME || null,",
        "  customAllowed: process.env.CUSTOM_ALLOWED || null,",
        "  mockSecret: process.env.MOCK_AWS_SECRET_KEY || null,",
        "  ghToken: process.env.GH_TOKEN || null,",
        "  codexToken: process.env.CODEX_TOKEN || null,",
        "  sshAuthSock: process.env.SSH_AUTH_SOCK || null",
        "}));"
      ].join("");
      const config = testConfig(root, {
        audit: { enabled: false },
        codexHandoff: {
          enabled: true,
          codexCommand: process.execPath,
          codexArgs: ["-e", workerScript],
          allowedEnvKeys: [
            "PATH",
            "CODEX_HOME",
            "CUSTOM_ALLOWED",
            "MOCK_AWS_SECRET_KEY",
            "GH_TOKEN",
            "SSH_AUTH_SOCK"
          ],
          allowedEnvPrefixes: ["CODEX_"]
        }
      });

      const created = await codexTaskCreateTool(config, {
        title: "Env task",
        prompt: "Check environment."
      });
      await processNextCodexTask(config, { workerId: "env-test-worker" });
      const task = await readCodexTask(config, created.task.id);
      const payload = JSON.parse(lastLine(task.result?.stdoutTail ?? "{}")) as {
        hasPath: boolean;
        codexHome: string | null;
        customAllowed: string | null;
        mockSecret: string | null;
        ghToken: string | null;
        codexToken: string | null;
        sshAuthSock: string | null;
      };

      expect(payload).toMatchObject({
        hasPath: true,
        codexHome: "/tmp/codex-home",
        customAllowed: "visible",
        mockSecret: null,
        ghToken: null,
        codexToken: null,
        sshAuthSock: null
      });
    } finally {
      restoreEnv(previousEnv);
    }
  });
});

async function makeWorkspace(): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "secure-mcp-codex-handoff-")));
}

function lastLine(value: string): string {
  return value.trim().split(/\r?\n/).at(-1) ?? "{}";
}

function saveEnv(keys: string[]): Record<string, string | undefined> {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition");
}
