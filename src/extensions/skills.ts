import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { RuntimeConfig } from "../config/config.js";
import { StructuredToolError } from "../policy/errors.js";
import { isSecretLikeRelativePath } from "../policy/pathPolicy.js";

const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export type DocumentSkillDescriptor = {
  name: string;
  description?: string;
  kind: "instruction";
  runtime: "markdown";
  revision: string;
  sha256: string;
  bytes: number;
  scope: "workspace" | "configured";
  contentTrust: "untrusted-instructions";
  execution: "none";
};

type LoadedDocumentSkill = DocumentSkillDescriptor & {
  content: Buffer;
};

export async function listDocumentSkills(
  config: RuntimeConfig,
  input: { query?: string } = {}
): Promise<DocumentSkillDescriptor[]> {
  ensureExtensionsEnabled(config);
  const query = input.query?.trim().toLowerCase();
  const loaded = await loadDocumentSkills(config);
  return loaded
    .filter((skill) => !query || skill.name.toLowerCase().includes(query) || skill.description?.toLowerCase().includes(query))
    .map(toDescriptor);
}

export async function readDocumentSkill(
  config: RuntimeConfig,
  input: { name: string; revision: string; offset?: number; limit?: number }
) {
  ensureExtensionsEnabled(config);
  const skill = (await loadDocumentSkills(config)).find((candidate) => candidate.name === input.name);
  if (!skill) {
    throw new StructuredToolError({
      code: "SKILL_NOT_FOUND",
      category: "not_found",
      message: `Configured document Skill was not found: ${input.name}`,
      recovery: discoverSkillRecovery(input.name)
    });
  }
  if (skill.revision !== input.revision) {
    throw new StructuredToolError({
      code: "SKILL_DISCOVERY_STALE",
      category: "runtime",
      message: `Skill content changed after discovery: ${input.name}`,
      retryable: true,
      recovery: discoverSkillRecovery(input.name),
      details: { expectedRevision: input.revision, currentRevision: skill.revision }
    });
  }
  const offset = input.offset ?? 0;
  if (offset < 0) {
    throw new StructuredToolError({
      code: "INVALID_ARGUMENT",
      category: "validation",
      message: "Skill offset must be non-negative"
    });
  }
  const max = Math.min(input.limit ?? config.extensions.maxSkillBytes, config.extensions.maxSkillBytes);
  const start = Math.min(offset, skill.content.length);
  const end = Math.min(skill.content.length, start + max);
  const nextOffset = end < skill.content.length ? end : undefined;
  return {
    skill: toDescriptor(skill),
    content: skill.content.subarray(start, end).toString("utf8"),
    encoding: "utf-8" as const,
    offset: start,
    nextOffset,
    bytesRead: end - start,
    totalBytes: skill.content.length,
    truncated: nextOffset !== undefined,
    nextAction: nextOffset !== undefined
      ? {
        tool: "skill_read",
        arguments: {
          name: skill.name,
          revision: skill.revision,
          offset: nextOffset,
          limit: input.limit
        },
        reason: "Continue reading the same configured Skill from the returned byte offset."
      }
      : undefined
  };
}

export async function describeDocumentSkill(config: RuntimeConfig, name: string) {
  const skill = (await loadDocumentSkills(config)).find((candidate) => candidate.name === name);
  if (!skill) {
    throw new StructuredToolError({
      code: "SKILL_NOT_FOUND",
      category: "not_found",
      message: `Configured document Skill was not found: ${name}`,
      recovery: {
        tool: "extension_discover",
        arguments: { kind: "skill" },
        reason: "Refresh the configured Skill names before selecting one."
      }
    });
  }
  const descriptor = toDescriptor(skill);
  return {
    ...descriptor,
    invocation: {
      tool: "skill_read",
      arguments: { name: descriptor.name, revision: descriptor.revision },
      reason: "Load the configured instructions without executing host code."
    }
  };
}

function ensureExtensionsEnabled(config: RuntimeConfig): void {
  if (!config.extensions.enabled) {
    throw new StructuredToolError({
      code: "EXTENSIONS_DISABLED",
      category: "permission",
      message: "The extension gateway is disabled by trusted runtime configuration."
    });
  }
}

async function loadDocumentSkills(config: RuntimeConfig): Promise<LoadedDocumentSkill[]> {
  const workspaceRoot = await fs.realpath(config.workspace.root);
  const skills: LoadedDocumentSkill[] = [];
  const names = new Set<string>();
  const maxDirectoriesScanned = Math.min(config.extensions.maxSkills * 10, 10000);
  let directoriesScanned = 0;

  for (const configuredDir of config.extensions.skillDirs) {
    if (skills.length >= config.extensions.maxSkills || directoriesScanned >= maxDirectoriesScanned) break;
    const absoluteConfiguredRoot = path.isAbsolute(configuredDir);
    const requestedRoot = absoluteConfiguredRoot
      ? path.resolve(configuredDir)
      : path.resolve(workspaceRoot, configuredDir);
    let root: string;
    try {
      root = await fs.realpath(requestedRoot);
      if (!(await fs.stat(root)).isDirectory()) continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const workspaceRelative = path.relative(workspaceRoot, root);
    const insideWorkspace = isSubpath(workspaceRoot, root);
    if (!absoluteConfiguredRoot && !insideWorkspace) {
      throw new StructuredToolError({
        code: "SKILL_ROOT_ESCAPE",
        category: "permission",
        message: `Relative Skill directory resolves outside the workspace: ${configuredDir}`
      });
    }
    if (insideWorkspace && isSecretLikeRelativePath(workspaceRelative)) {
      throw new StructuredToolError({
        code: "SKILL_ROOT_BLOCKED",
        category: "permission",
        message: `Configured Skill directory is secret-like: ${configuredDir}`
      });
    }

    const entries = await fs.opendir(root);
    for await (const entry of entries) {
      if (skills.length >= config.extensions.maxSkills || directoriesScanned >= maxDirectoriesScanned) break;
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      directoriesScanned += 1;
      const directory = path.join(root, entry.name);
      const realDirectory = await fs.realpath(directory);
      if (!isSubpath(root, realDirectory)) continue;
      const loaded = await loadSkillFile(config, realDirectory, entry.name, insideWorkspace ? "workspace" : "configured");
      if (!loaded || names.has(loaded.name)) continue;
      names.add(loaded.name);
      skills.push(loaded);
    }
  }

  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

async function loadSkillFile(
  config: RuntimeConfig,
  directory: string,
  fallbackName: string,
  scope: DocumentSkillDescriptor["scope"]
): Promise<LoadedDocumentSkill | undefined> {
  for (const filename of ["SKILL.md", "skill.md"]) {
    const candidate = path.join(directory, filename);
    let handle: Awaited<ReturnType<typeof fs.open>>;
    try {
      handle = await fs.open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      // A Skill file must be a regular file at the configured location. In
      // particular, do not follow a symlink that could be swapped after scan.
      if (code === "ELOOP" || code === "EMLINK") return undefined;
      throw error;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > config.extensions.maxSkillBytes) return undefined;
      const content = await handle.readFile();
      if (content.length > config.extensions.maxSkillBytes) return undefined;
      const metadata = parseFrontmatter(content.toString("utf8"));
      const name = metadata.name || fallbackName;
      if (!SKILL_NAME_PATTERN.test(name)) return undefined;
      const sha256 = createHash("sha256").update(content).digest("hex");
      return {
        name,
        description: metadata.description?.slice(0, 500),
        kind: "instruction",
        runtime: "markdown",
        revision: `sha256:${sha256}`,
        sha256,
        bytes: content.length,
        scope,
        contentTrust: "untrusted-instructions",
        execution: "none",
        content
      };
    } finally {
      await handle.close();
    }
  }
  return undefined;
}

function parseFrontmatter(content: string): { name?: string; description?: string } {
  const normalized = content.replace(/^\uFEFF/, "");
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(normalized);
  if (!match) return {};
  const result: { name?: string; description?: string } = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^(name|description)\s*:\s*(.+?)\s*$/.exec(line);
    if (!field) continue;
    const value = stripSimpleQuotes(field[2]);
    if (field[1] === "name") result.name = value;
    if (field[1] === "description") result.description = value;
  }
  return result;
}

function stripSimpleQuotes(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function toDescriptor(skill: LoadedDocumentSkill): DocumentSkillDescriptor {
  const { content: _content, ...descriptor } = skill;
  return descriptor;
}

function discoverSkillRecovery(name: string) {
  return {
    tool: "extension_discover",
    arguments: { kind: "skill", name },
    reason: "Refresh the configured Skill descriptor and revision before reading it."
  };
}

function isSubpath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
