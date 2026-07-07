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

    const tail = await codexTaskTailTool(config, { taskId: created.task.id });
    expect(tail.content).toContain("STDOUT:");
    expect(tail.content).toContain('"hasPrompt":true');
  });
});

async function makeWorkspace(): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "secure-mcp-codex-handoff-")));
}
