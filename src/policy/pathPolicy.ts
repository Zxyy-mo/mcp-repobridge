import fs from "node:fs/promises";
import path from "node:path";
import { PolicyError } from "./errors.js";

const SECRET_FILE_PATTERNS = [
  /^\.env(\.|$)?/,
  /^id_rsa$/,
  /^id_ed25519$/,
  /^\.npmrc$/,
  /^credentials$/,
  /^config$/
];

const SECRET_PATH_PARTS = new Set([
  ".secure-mcp",
  ".ssh",
  ".aws",
  ".gcloud",
  ".azure",
  ".config"
]);

export async function resolveWorkspacePath(workspaceRoot: string, requestedPath: string): Promise<string> {
  const rootReal = await fs.realpath(workspaceRoot);
  const candidate = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(rootReal, requestedPath);

  if (!isSubpath(rootReal, candidate)) {
    throw new PolicyError(`Path escapes workspace: ${requestedPath}`);
  }

  // If the target exists, follow symlinks and ensure the real target is also inside workspace.
  try {
    const realCandidate = await fs.realpath(candidate);
    if (!isSubpath(rootReal, realCandidate)) {
      throw new PolicyError(`Symlink escapes workspace: ${requestedPath}`);
    }
    return realCandidate;
  } catch (error: unknown) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return candidate;
    }
    throw error;
  }
}

export function assertNotSecretLike(workspaceRoot: string, absolutePath: string): void {
  const relative = path.relative(workspaceRoot, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new PolicyError(`Path escapes workspace: ${absolutePath}`);
  }
  const normalized = relative.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => SECRET_PATH_PARTS.has(part))) {
    throw new PolicyError(`Secret-like path is blocked: ${relative}`);
  }
  const basename = parts.at(-1) ?? "";
  if (SECRET_FILE_PATTERNS.some((pattern) => pattern.test(basename))) {
    throw new PolicyError(`Secret-like file is blocked: ${relative}`);
  }
}

export function isSecretLikeRelativePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => SECRET_PATH_PARTS.has(part))) return true;
  const basename = parts.at(-1) ?? "";
  return SECRET_FILE_PATTERNS.some((pattern) => pattern.test(basename));
}

function isSubpath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
