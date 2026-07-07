import { describe, expect, it } from "vitest";
import { validateCommand } from "../src/policy/commandPolicy.js";

describe("command policy", () => {
  it("allows a harmless command", () => {
    expect(() => validateCommand("echo ok")).not.toThrow();
  });
  it("rejects network tools", () => {
    expect(() => validateCommand("curl https://example.com")).toThrow();
  });
  it("rejects docker commands", () => {
    expect(() => validateCommand("docker ps")).toThrow();
  });
  it("rejects destructive absolute rm commands", () => {
    expect(() => validateCommand("rm -rf /")).toThrow();
    expect(() => validateCommand("rm -fr /workspace")).toThrow();
  });
  it("enforces allowlist mode before execution", () => {
    expect(() => validateCommand("npm test", { mode: "allowlist", allowedCommands: ["npm"] })).not.toThrow();
    expect(() => validateCommand("git status", { mode: "allowlist", allowedCommands: ["npm"] })).toThrow(/allowlist/);
  });
});
