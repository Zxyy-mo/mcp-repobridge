import { createHash } from "node:crypto";
import { PolicyError } from "../policy/errors.js";

type CursorEnvelope = {
  version: 1;
  kind: string;
  scope: string;
  position: unknown;
};

export function encodeCursor(kind: string, scope: unknown, position: unknown): string {
  const envelope: CursorEnvelope = {
    version: 1,
    kind,
    scope: scopeDigest(scope),
    position
  };
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64url");
}

export function decodeCursor<T>(cursor: string | undefined, kind: string, scope: unknown): T | undefined {
  if (!cursor) return undefined;
  if (cursor.length > 4096) throw new PolicyError("Cursor exceeds maximum length");
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as CursorEnvelope;
    if (decoded.version !== 1 || decoded.kind !== kind || decoded.scope !== scopeDigest(scope)) {
      throw new Error("cursor scope mismatch");
    }
    return decoded.position as T;
  } catch {
    throw new PolicyError(`Invalid or mismatched ${kind} cursor`);
  }
}

function scopeDigest(scope: unknown): string {
  return createHash("sha256").update(stableStringify(scope)).digest("hex").slice(0, 24);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
