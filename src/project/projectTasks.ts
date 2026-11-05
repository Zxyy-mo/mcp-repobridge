import fs from "node:fs/promises";
import path from "node:path";

export type ProjectTask = {
  name: string;
  command: string;
  source: string;
  kind: "test" | "build" | "lint" | "serve" | "custom";
};

export type ProjectDiagnostic = {
  path?: string;
  line?: number;
  column?: number;
  severity: "error" | "warning" | "info";
  message: string;
};

const SAFE_TASK_NAME = /^[A-Za-z0-9][A-Za-z0-9:_./-]{0,199}$/;

export async function discoverProjectTasks(root: string): Promise<ProjectTask[]> {
  const tasks = new Map<string, ProjectTask>();
  await discoverPackageTasks(root, tasks);
  if (await isFile(root, "go.mod")) {
    addDefault(tasks, { name: "test", command: "go test ./...", source: "go.mod", kind: "test" });
    addDefault(tasks, { name: "build", command: "go build ./...", source: "go.mod", kind: "build" });
    addDefault(tasks, { name: "vet", command: "go vet ./...", source: "go.mod", kind: "lint" });
  }
  if (await isFile(root, "Cargo.toml")) {
    addDefault(tasks, { name: "test", command: "cargo test", source: "Cargo.toml", kind: "test" });
    addDefault(tasks, { name: "build", command: "cargo build", source: "Cargo.toml", kind: "build" });
    addDefault(tasks, { name: "check", command: "cargo check", source: "Cargo.toml", kind: "lint" });
  }
  if (await isFile(root, "pyproject.toml") || await isFile(root, "pytest.ini")) {
    addDefault(tasks, { name: "test", command: "python -m pytest", source: "pyproject.toml", kind: "test" });
  }
  await discoverMakeTasks(root, tasks);
  return [...tasks.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export async function findProjectTask(root: string, name: string): Promise<ProjectTask | undefined> {
  if (!SAFE_TASK_NAME.test(name)) return undefined;
  return (await discoverProjectTasks(root)).find((task) => task.name === name);
}

export function parseProjectDiagnostics(output: string, limit = 100): ProjectDiagnostic[] {
  const patterns = [
    /^(.+?):(\d+):(\d+):\s*(?:(error|warning|info)\s*:?\s*)?(.+)$/i,
    /^(.+?)\((\d+),(\d+)\):\s*(?:(error|warning|info)\s*:?\s*)?(.+)$/i,
    /^(.+?):(\d+):\s*(?:(error|warning|info)\s*:?\s*)?(.+)$/i
  ];
  const diagnostics: ProjectDiagnostic[] = [];
  const seen = new Set<string>();
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    for (const pattern of patterns) {
      const match = pattern.exec(line);
      if (!match) continue;
      const hasColumn = match.length === 6;
      const severityValue = (hasColumn ? match[4] : match[3])?.toLowerCase();
      const diagnostic: ProjectDiagnostic = {
        path: match[1].replace(/\\/g, "/"),
        line: Number(match[2]),
        column: hasColumn ? Number(match[3]) : undefined,
        severity: severityValue === "warning" || severityValue === "info" ? severityValue : "error",
        message: hasColumn ? match[5] : match[4]
      };
      const key = JSON.stringify(diagnostic);
      if (!seen.has(key)) {
        seen.add(key);
        diagnostics.push(diagnostic);
      }
      break;
    }
    if (diagnostics.length >= Math.min(Math.max(limit, 1), 500)) break;
  }
  return diagnostics;
}

async function discoverPackageTasks(root: string, tasks: Map<string, ProjectTask>) {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    const runner = await packageRunner(root);
    for (const [name, script] of Object.entries(manifest.scripts ?? {})) {
      if (typeof script !== "string" || !SAFE_TASK_NAME.test(name)) continue;
      tasks.set(name, {
        name,
        command: `${runner} run ${name}`,
        source: "package.json",
        kind: taskKind(name)
      });
    }
  } catch {
    // Missing or invalid package.json contributes no tasks.
  }
}

async function discoverMakeTasks(root: string, tasks: Map<string, ProjectTask>) {
  try {
    const content = await fs.readFile(path.join(root, "Makefile"), "utf8");
    for (const line of content.split(/\r?\n/)) {
      if (/^[.\t]/.test(line)) continue;
      const match = /^([A-Za-z0-9][A-Za-z0-9_.-]{0,199})\s*:/.exec(line);
      if (!match || !SAFE_TASK_NAME.test(match[1])) continue;
      addDefault(tasks, {
        name: match[1],
        command: `make ${match[1]}`,
        source: "Makefile",
        kind: taskKind(match[1])
      });
    }
  } catch {
    // Missing Makefile contributes no tasks.
  }
}

async function packageRunner(root: string): Promise<string> {
  if (await isFile(root, "pnpm-lock.yaml")) return "pnpm";
  if (await isFile(root, "yarn.lock")) return "yarn";
  if (await isFile(root, "bun.lock") || await isFile(root, "bun.lockb")) return "bun";
  return "npm";
}

async function isFile(root: string, name: string): Promise<boolean> {
  try {
    return (await fs.stat(path.join(root, name))).isFile();
  } catch {
    return false;
  }
}

function addDefault(tasks: Map<string, ProjectTask>, task: ProjectTask) {
  if (!tasks.has(task.name)) tasks.set(task.name, task);
}

function taskKind(name: string): ProjectTask["kind"] {
  const value = name.toLowerCase();
  if (value.includes("test")) return "test";
  if (value.includes("lint") || value.includes("check") || value.includes("vet")) return "lint";
  if (value.includes("build") || value.includes("compile")) return "build";
  if (value.includes("serve") || value.includes("start") || value.includes("dev")) return "serve";
  return "custom";
}
