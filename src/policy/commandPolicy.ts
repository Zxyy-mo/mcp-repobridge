import { PolicyError } from "./errors.js";

const DENY_PATTERNS: RegExp[] = [
  /(^|[\s;&|])(?:\S+\/)?curl(\s|$)/i,
  /(^|[\s;&|])(?:\S+\/)?wget(\s|$)/i,
  /(^|[\s;&|])(?:\S+\/)?nc(\s|$)/i,
  /(^|[\s;&|])(?:\S+\/)?ncat(\s|$)/i,
  /(^|[\s;&|])(?:\S+\/)?socat(\s|$)/i,
  /(^|[\s;&|])(?:\S+\/)?ssh(\s|$)/i,
  /(^|[\s;&|])(?:\S+\/)?scp(\s|$)/i,
  /(^|[\s;&|])(?:\S+\/)?rsync(\s|$)/i,
  /\/dev\/tcp/i,
  /(^|[\s;&|])(?:\S+\/)?docker(\s|$)/i,
  /(^|[\s;&|])(?:\S+\/)?podman(\s|$)/i,
  /(^|[\s;&|])(?:\S+\/)?kubectl(\s|$)/i,
  /(^|[\s;&|])(?:\S+\/)?sudo(\s|$)/i,
  /(^|[\s;&|])(?:\S+\/)?su(\s|$)/i,
  /chmod\s+777/i,
  /chown\s+-R/i,
  /rm\s+-[^\s]*r[^\s]*f[^\s]*\s+\//i,
  /rm\s+-[^\s]*f[^\s]*r[^\s]*\s+\//i,
  /rm\s+-[^\s]*r[^\s]*f[^\s]*\s+\/workspace\b/i,
  /rm\s+-[^\s]*f[^\s]*r[^\s]*\s+\/workspace\b/i
];

export function validateCommand(
  command: string,
  options?: {
    maxLength?: number;
    mode?: "denylist" | "allowlist";
    allowedCommands?: string[];
  }
): void {
  const maxLength = options?.maxLength ?? 2000;
  const trimmed = command.trim();
  if (!command.trim()) {
    throw new PolicyError("Command cannot be empty");
  }
  if (command.length > maxLength) {
    throw new PolicyError(`Command exceeds max length ${maxLength}`);
  }
  if (options?.mode === "allowlist") {
    const allowed = options.allowedCommands ?? [];
    if (!allowed.some((prefix) => trimmed === prefix || trimmed.startsWith(`${prefix} `))) {
      throw new PolicyError("Command rejected by allowlist policy");
    }
  }
  for (const pattern of DENY_PATTERNS) {
    if (pattern.test(command)) {
      throw new PolicyError(`Command rejected by policy: ${pattern}`);
    }
  }
}
