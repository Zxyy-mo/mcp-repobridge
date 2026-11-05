import { describe, expect, it } from "vitest";
import { PolicyError, StructuredToolError } from "../src/policy/errors.js";
import { safeToolCall, type ToolEnvelope } from "../src/server/toolEnvelope.js";

describe("tool envelope", () => {
  it("returns compact text with structured success data", async () => {
    const result = await safeToolCall("read_file", async () => ({
      path: "src/index.ts",
      content: "hello",
      bytesRead: 5,
      truncated: false
    }));
    const envelope = result.structuredContent as ToolEnvelope;

    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: "text", text: "Read src/index.ts (5 bytes)." }]);
    expect(envelope).toMatchObject({
      status: "succeeded",
      data: { path: "src/index.ts", content: "hello" },
      meta: { tool: "read_file" }
    });
    expect(envelope.meta.requestId).toMatch(/^req_/);
  });

  it("normalizes policy failures without throwing through the MCP boundary", async () => {
    const result = await safeToolCall("read_file", async () => {
      throw new PolicyError("Secret-like file is blocked: .env");
    });
    const envelope = result.structuredContent as ToolEnvelope;

    expect(result.isError).toBe(true);
    expect(envelope).toMatchObject({
      status: "failed",
      error: { code: "POLICY_DENIED", category: "permission", retryable: false }
    });
  });

  it("provides an executable recovery action when the sandbox is absent", async () => {
    const result = await safeToolCall("exec_container", async () => ({
      code: 1,
      signal: null,
      stdout: "",
      stderr: "Error response from daemon: No such container: secure-mcp-sandbox",
      timedOut: false,
      truncated: false
    }));
    const envelope = result.structuredContent as ToolEnvelope;

    expect(result.isError).toBe(true);
    expect(envelope.error).toMatchObject({
      code: "SANDBOX_NOT_RUNNING",
      retryable: true,
      recovery: { tool: "sandbox_start", arguments: {} }
    });
    expect(envelope.nextAction).toEqual(envelope.error?.recovery);
  });

  it("treats a failed resolved project task as an execution failure", async () => {
    const result = await safeToolCall("project_task_run", async () => ({
      code: 2,
      signal: null,
      stdout: "",
      stderr: "tests failed",
      timedOut: false,
      truncated: false
    }));
    const envelope = result.structuredContent as ToolEnvelope;

    expect(result.isError).toBe(true);
    expect(envelope.error).toMatchObject({ code: "COMMAND_FAILED", category: "execution" });
  });

  it("preserves safe structured extension errors and recovery", async () => {
    const result = await safeToolCall("mcp_call", async () => {
      throw new StructuredToolError({
        code: "MCP_DISCOVERY_STALE",
        category: "runtime",
        message: "Refresh discovery",
        retryable: true,
        recovery: {
          tool: "extension_discover",
          arguments: { kind: "mcp", name: "demo" },
          reason: "Schema changed"
        }
      });
    });
    const envelope = result.structuredContent as ToolEnvelope;

    expect(result.isError).toBe(true);
    expect(envelope.error).toMatchObject({
      code: "MCP_DISCOVERY_STALE",
      category: "runtime",
      retryable: true,
      recovery: { tool: "extension_discover" }
    });
    expect(envelope.nextAction).toEqual(envelope.error?.recovery);
  });
});
