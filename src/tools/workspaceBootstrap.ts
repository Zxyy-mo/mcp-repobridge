import fs from "node:fs/promises";
import path from "node:path";
import type { RuntimeConfig } from "../config/config.js";
import { auditToolCall } from "../audit/auditLog.js";
import { listCodexTasks } from "../codexHandoff/taskStore.js";
import { listWorkerHeartbeats } from "../codexHandoff/workerHeartbeat.js";
import { isSecretLikeRelativePath } from "../policy/pathPolicy.js";
import { inspectSandboxState } from "../sandbox/dockerClient.js";
import { discoverProjectTasks } from "../project/projectTasks.js";
import { listConfiguredMcpServers } from "../extensions/mcpProxy.js";
import { listDocumentSkills } from "../extensions/skills.js";

const PROJECT_MARKERS: Array<{ file: string; language?: string }> = [
  { file: "package.json", language: "javascript/typescript" },
  { file: "tsconfig.json", language: "typescript" },
  { file: "pyproject.toml", language: "python" },
  { file: "requirements.txt", language: "python" },
  { file: "go.mod", language: "go" },
  { file: "Cargo.toml", language: "rust" },
  { file: "pom.xml", language: "java" },
  { file: "build.gradle", language: "java/kotlin" },
  { file: "Makefile" },
  { file: "Dockerfile" }
];

export async function workspaceBootstrapTool(config: RuntimeConfig) {
  return auditToolCall(config, "workspace_bootstrap", {}, async () => {
    const [sandbox, project, git, handoff, extensions] = await Promise.all([
      inspectSandboxState(config),
      inspectProject(config),
      inspectGitHead(config.workspace.root),
      inspectHandoff(config),
      inspectExtensions(config)
    ]);
    const sandboxReady = sandbox.running && sandbox.managed;
    const { workspaceSource: _workspaceSource, ...publicSandbox } = sandbox;
    return {
      ready: sandboxReady || !config.policy.allowExec,
      capabilities: {
        hostRead: true,
        hostWrite: false,
        hostShell: false,
        sandboxExec: config.policy.allowExec,
        sandboxNetwork: config.sandbox.network,
        codexHandoff: config.codexHandoff.enabled,
        documentSkills: config.extensions.enabled,
        trustedHostMcp: config.extensions.enabled && config.extensions.hostMcpEnabled
      },
      workspace: {
        name: path.basename(config.workspace.root),
        root: config.workspace.root,
        ...project,
        git
      },
      sandbox: {
        ...publicSandbox,
        ready: sandboxReady,
        startMode: config.sandbox.startMode,
        workspaceMode: "filtered-ephemeral-copy",
        configuredImage: config.sandbox.image,
        network: config.sandbox.network
      },
      handoff,
      extensions,
      nextAction: config.policy.allowExec && !sandboxReady
        ? {
          tool: "sandbox_start",
          arguments: {},
          reason: "Start the fixed sandbox before running commands; on-demand mode will also start it on first execution."
        }
        : undefined
    };
  });
}

async function inspectExtensions(config: RuntimeConfig) {
  if (!config.extensions.enabled) {
    return { enabled: false, hostMcpEnabled: false, skills: [], mcpServers: [] };
  }
  const skills = await listDocumentSkills(config);
  return {
    enabled: true,
    hostMcpEnabled: config.extensions.hostMcpEnabled,
    skillCount: skills.length,
    skills: skills.map(({ name, description, revision, scope }) => ({ name, description, revision, scope })),
    mcpServers: listConfiguredMcpServers(config)
  };
}

async function inspectProject(config: RuntimeConfig) {
  const entries = (await fs.readdir(config.workspace.root, { withFileTypes: true }))
    .filter((entry) => !config.policy.denySecretsRead || !isSecretLikeRelativePath(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  const names = new Set(entries.map((entry) => entry.name));
  const manifests = PROJECT_MARKERS.filter((marker) => names.has(marker.file)).map((marker) => marker.file);
  const languages = [...new Set(PROJECT_MARKERS
    .filter((marker) => marker.language && names.has(marker.file))
    .map((marker) => marker.language as string))];
  const projectTasks = await discoverProjectTasks(config.workspace.root);
  return {
    manifests,
    languages,
    projectTasks: projectTasks.map(({ name, kind, source }) => ({ name, kind, source })),
    topLevelEntries: entries.slice(0, 100).map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : entry.isSymbolicLink() ? "symlink" : "other"
    })),
    topLevelTruncated: entries.length > 100
  };
}

async function inspectGitHead(workspaceRoot: string): Promise<{ ref?: string; commit?: string } | undefined> {
  try {
    const gitPath = path.join(workspaceRoot, ".git");
    const stat = await fs.lstat(gitPath);
    if (!stat.isDirectory()) return undefined;
    const head = (await fs.readFile(path.join(gitPath, "HEAD"), "utf8")).trim();
    if (/^[a-f0-9]{40}$/i.test(head)) return { commit: head };
    const match = /^ref: (refs\/[A-Za-z0-9._/-]+)$/.exec(head);
    if (!match || match[1].split("/").includes("..")) return undefined;
    let commit: string | undefined;
    try {
      const value = (await fs.readFile(path.join(gitPath, match[1]), "utf8")).trim();
      if (/^[a-f0-9]{40}$/i.test(value)) commit = value;
    } catch {
      // Packed refs and unborn branches are represented by ref only.
    }
    return { ref: match[1], commit };
  } catch {
    return undefined;
  }
}

async function inspectHandoff(config: RuntimeConfig) {
  if (!config.codexHandoff.enabled) return { enabled: false, workerOnline: false };
  const [heartbeat, tasks] = await Promise.all([
    listWorkerHeartbeats(config),
    listCodexTasks(config, { limit: config.codexHandoff.maxTasksListed })
  ]);
  return {
    enabled: true,
    workerOnline: heartbeat.online,
    workers: heartbeat.workers,
    queued: tasks.filter((task) => task.status === "queued").length,
    running: tasks.filter((task) => task.status === "running").length,
    workerCommand: "npm run --silent codex-worker -- --config <runtime.config.json>"
  };
}
