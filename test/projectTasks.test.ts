import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverProjectTasks, findProjectTask, parseProjectDiagnostics } from "../src/project/projectTasks.js";

describe("project tasks", () => {
  it("discovers safe manifest tasks without returning script bodies", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "project-tasks-")));
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
      scripts: {
        test: "vitest run",
        build: "tsc",
        "unsafe;name": "echo unsafe"
      }
    }));
    await fs.writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
    await fs.writeFile(path.join(root, "Makefile"), "lint:\n\t@echo lint\n");

    const tasks = await discoverProjectTasks(root);

    expect(tasks).toEqual(expect.arrayContaining([
      { name: "test", command: "pnpm run test", source: "package.json", kind: "test" },
      { name: "build", command: "pnpm run build", source: "package.json", kind: "build" },
      { name: "lint", command: "make lint", source: "Makefile", kind: "lint" }
    ]));
    expect(tasks.map((task) => task.name)).not.toContain("unsafe;name");
    await expect(findProjectTask(root, "unsafe;name")).resolves.toBeUndefined();
  });

  it("adds conventional tasks for language manifests without overriding explicit scripts", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "project-tasks-go-")));
    await fs.writeFile(path.join(root, "go.mod"), "module example.test/project\n");

    await expect(discoverProjectTasks(root)).resolves.toEqual(expect.arrayContaining([
      { name: "test", command: "go test ./...", source: "go.mod", kind: "test" },
      { name: "build", command: "go build ./...", source: "go.mod", kind: "build" }
    ]));
  });

  it("parses common compiler diagnostics into model-friendly fields", () => {
    const diagnostics = parseProjectDiagnostics([
      "src/app.ts:12:7: error: unexpected token",
      "pkg/main.go:8: warning: unused value",
      "src/app.ts:12:7: error: unexpected token"
    ].join("\n"));

    expect(diagnostics).toEqual([
      { path: "src/app.ts", line: 12, column: 7, severity: "error", message: "unexpected token" },
      { path: "pkg/main.go", line: 8, column: undefined, severity: "warning", message: "unused value" }
    ]);
  });
});
