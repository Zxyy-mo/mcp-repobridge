import { randomUUID } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { PolicyError, StructuredToolError } from "../policy/errors.js";

export type ToolRecovery = {
  tool: string;
  arguments: Record<string, unknown>;
  reason: string;
};

export type ToolErrorBody = {
  code: string;
  category: "validation" | "permission" | "not_found" | "execution" | "runtime" | "internal";
  message: string;
  retryable: boolean;
  recovery?: ToolRecovery;
  details?: Record<string, unknown>;
};

export type ToolEnvelope = {
  status: "succeeded" | "accepted" | "failed";
  data?: unknown;
  meta: {
    requestId: string;
    tool: string;
    durationMs: number;
  };
  nextAction?: ToolRecovery;
  error?: ToolErrorBody;
};

export async function safeToolCall(tool: string, call: () => Promise<unknown>): Promise<CallToolResult> {
  const started = Date.now();
  const requestId = `req_${randomUUID()}`;
  try {
    const data = await call();
    const derivedError = deriveResultError(tool, data);
    const envelope: ToolEnvelope = derivedError
      ? {
        status: "failed",
        data,
        meta: { requestId, tool, durationMs: Date.now() - started },
        nextAction: derivedError.recovery,
        error: derivedError
      }
      : {
        status: isRecord(data) && data.accepted === true ? "accepted" : "succeeded",
        data,
        meta: { requestId, tool, durationMs: Date.now() - started },
        nextAction: deriveNextAction(tool, data)
      };
    return envelopeResult(envelope);
  } catch (error) {
    const classified = classifyThrownError(tool, error);
    const envelope: ToolEnvelope = {
      status: "failed",
      meta: { requestId, tool, durationMs: Date.now() - started },
      nextAction: classified.recovery,
      error: classified
    };
    return envelopeResult(envelope);
  }
}

export function envelopeResult(envelope: ToolEnvelope): CallToolResult {
  return {
    content: [{ type: "text", text: summarizeEnvelope(envelope) }],
    structuredContent: envelope,
    isError: envelope.status === "failed"
  };
}

function deriveResultError(tool: string, data: unknown): ToolErrorBody | undefined {
  if (!isRecord(data)) return undefined;
  const code = typeof data.code === "number" || data.code === null ? data.code : undefined;
  const stderr = typeof data.stderr === "string" ? data.stderr : "";
  const timedOut = data.timedOut === true;
  if (tool === "mcp_call" && isRecord(data.upstream) && data.upstream.isError === true) {
    return {
      code: "MCP_CALL_FAILED",
      category: "execution",
      message: "The configured upstream MCP tool returned an error result.",
      retryable: false,
      details: {
        server: data.server,
        tool: data.tool
      }
    };
  }
  if (/unmanaged container/i.test(stderr)) {
    return {
      code: "SANDBOX_NAME_CONFLICT",
      category: "runtime",
      message: "The configured container name belongs to a container not managed by MCP RepoBridge.",
      retryable: false
    };
  }
  if ((tool === "exec_container" || tool === "project_task_run") && (code !== 0 || timedOut)) {
    if (/no such container/i.test(stderr)) {
      return {
        code: "SANDBOX_NOT_RUNNING",
        category: "runtime",
        message: "The configured Docker sandbox is not running.",
        retryable: true,
        recovery: {
          tool: "sandbox_start",
          arguments: {},
          reason: "Start the fixed configured sandbox, then retry the same command."
        }
      };
    }
    if (timedOut) {
      return {
        code: "COMMAND_TIMEOUT",
        category: "execution",
        message: "The sandbox command exceeded its configured timeout.",
        retryable: false,
        details: { exitCode: code }
      };
    }
    return {
      code: "COMMAND_FAILED",
      category: "execution",
      message: "The sandbox command exited unsuccessfully.",
      retryable: false,
      details: { exitCode: code, signal: data.signal }
    };
  }
  if ((tool === "sandbox_start" || tool === "sandbox_stop") && code !== undefined && code !== 0) {
    return {
      code: tool === "sandbox_start" ? "SANDBOX_START_FAILED" : "SANDBOX_STOP_FAILED",
      category: "runtime",
      message: `The configured sandbox could not be ${tool === "sandbox_start" ? "started" : "stopped"}.`,
      retryable: true,
      details: { exitCode: code }
    };
  }
  return undefined;
}

function deriveNextAction(tool: string, data: unknown): ToolRecovery | undefined {
  if (!isRecord(data)) return undefined;
  if (isRecovery(data.nextAction)) return data.nextAction;
  if (tool === "read_file" && typeof data.path === "string" && typeof data.nextOffset === "number") {
    return {
      tool: "read_file",
      arguments: { path: data.path, offset: data.nextOffset },
      reason: "Continue reading the truncated file from the returned byte offset."
    };
  }
  if (tool === "sandbox_status" && data.running === false) {
    return {
      tool: "sandbox_start",
      arguments: {},
      reason: "Start the fixed configured sandbox before executing commands."
    };
  }
  return undefined;
}

function isRecovery(value: unknown): value is ToolRecovery {
  return isRecord(value) && typeof value.tool === "string" && isRecord(value.arguments) && typeof value.reason === "string";
}

function classifyThrownError(tool: string, error: unknown): ToolErrorBody {
  const message = error instanceof Error ? error.message : String(error);
  const nodeCode = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
  if (error instanceof StructuredToolError) {
    return {
      code: error.toolCode,
      category: error.category,
      message: error.message,
      retryable: error.retryable,
      recovery: error.recovery,
      details: error.details
    };
  }
  if (/no such container/i.test(message)) {
    return {
      code: "SANDBOX_NOT_RUNNING",
      category: "runtime",
      message: "The configured Docker sandbox is not running.",
      retryable: true,
      recovery: {
        tool: "sandbox_start",
        arguments: {},
        reason: "Start the fixed configured sandbox, then retry the original request."
      }
    };
  }
  if (/cannot connect to the docker daemon|docker daemon is running/i.test(message)) {
    return {
      code: "DOCKER_UNAVAILABLE",
      category: "runtime",
      message: "The Docker daemon is unavailable to MCP RepoBridge.",
      retryable: true
    };
  }
  if (/spawn docker ENOENT|docker executable.*not found/i.test(message)) {
    return {
      code: "DOCKER_UNAVAILABLE",
      category: "runtime",
      message: "The Docker executable is unavailable to MCP RepoBridge.",
      retryable: false
    };
  }
  if (/unmanaged container/i.test(message)) {
    return {
      code: "SANDBOX_NAME_CONFLICT",
      category: "runtime",
      message: "The configured container name belongs to a container not managed by MCP RepoBridge.",
      retryable: false
    };
  }
  if (nodeCode === "ENOENT") {
    return {
      code: "NOT_FOUND",
      category: "not_found",
      message,
      retryable: false,
      recovery: recoveryForNotFound(tool)
    };
  }
  if (nodeCode === "EACCES" || nodeCode === "EPERM") {
    return {
      code: "PERMISSION_DENIED",
      category: "permission",
      message,
      retryable: false
    };
  }
  if (error instanceof PolicyError) {
    const denied = /blocked|rejected|disabled by policy|escapes workspace|symlink escapes/i.test(message);
    return {
      code: denied ? "POLICY_DENIED" : "INVALID_ARGUMENT",
      category: denied ? "permission" : "validation",
      message,
      retryable: false
    };
  }
  if (/must be|cannot be empty|exceeds|max length|positive|unsafe glob|invalid/i.test(message)) {
    return {
      code: "INVALID_ARGUMENT",
      category: "validation",
      message,
      retryable: false
    };
  }
  return {
    code: "INTERNAL_ERROR",
    category: "internal",
    message,
    retryable: false
  };
}

function recoveryForNotFound(tool: string): ToolRecovery | undefined {
  if (tool === "read_file") {
    return {
      tool: "find_files",
      arguments: { pattern: "**/*" },
      reason: "Locate the intended workspace path before retrying the read."
    };
  }
  if (tool === "codex_task_status" || tool === "codex_task_tail" || tool === "codex_task_cancel") {
    return {
      tool: "codex_task_list",
      arguments: {},
      reason: "Refresh the available Codex task identifiers."
    };
  }
  return undefined;
}

function summarizeEnvelope(envelope: ToolEnvelope): string {
  if (envelope.status === "failed") {
    return `${envelope.meta.tool} failed [${envelope.error?.code ?? "UNKNOWN"}]: ${envelope.error?.message ?? "Unknown error"}`;
  }
  const data = isRecord(envelope.data) ? envelope.data : undefined;
  if (envelope.meta.tool === "read_file" && data) {
    return `Read ${String(data.path ?? "file")} (${String(data.bytesRead ?? 0)} bytes${data.truncated ? ", truncated" : ""}).`;
  }
  if (envelope.meta.tool === "read_files" && data && Array.isArray(data.results)) {
    return `Read ${data.results.length} workspace files (${String(data.totalBytes ?? 0)} bytes${data.truncated ? ", continuation available" : ""}).`;
  }
  if (envelope.meta.tool === "list_directory" && data && Array.isArray(data.entries)) {
    return `Listed ${data.entries.length} workspace entries${data.truncated ? " (truncated)" : ""}.`;
  }
  if (envelope.meta.tool === "grep_files" && data && Array.isArray(data.matches)) {
    return `Found ${data.matches.length} text matches${data.truncated ? " (truncated)" : ""}.`;
  }
  if (envelope.meta.tool === "find_files" && data && Array.isArray(data.results)) {
    return `Found ${data.results.length} workspace paths${data.truncated ? " (truncated)" : ""}.`;
  }
  if (envelope.meta.tool === "exec_container" && data) {
    if (data.accepted === true) return `Sandbox command is running as task ${String(data.taskId ?? "unknown")}.`;
    return `Sandbox command completed with exit code ${String(data.code ?? "unknown")}.`;
  }
  if (envelope.meta.tool === "project_task_list" && data) {
    return `Discovered ${String(data.count ?? 0)} project tasks.`;
  }
  if (envelope.meta.tool === "project_task_run" && data) {
    if (data.accepted === true) return `Project task is running as sandbox task ${String(data.taskId ?? "unknown")}.`;
    return `Project task completed with exit code ${String(data.code ?? "unknown")}.`;
  }
  if (envelope.meta.tool === "sandbox_status" && data) {
    return data.running === true ? "Sandbox is running." : "Sandbox is not running.";
  }
  if (envelope.meta.tool === "workspace_bootstrap" && data) {
    return data.ready === true ? "Workspace runtime is ready." : "Workspace runtime needs setup; follow nextAction.";
  }
  if (envelope.meta.tool === "extension_discover" && data) {
    return `Discovered ${String(data.count ?? 1)} configured ${String(data.kind ?? "extension")} item(s).`;
  }
  if (envelope.meta.tool === "skill_read" && data) {
    return `Read configured Skill ${String(isRecord(data.skill) ? data.skill.name : "instructions")} (${String(data.bytesRead ?? 0)} bytes).`;
  }
  if (envelope.meta.tool === "mcp_call" && data) {
    return `Configured MCP call ${String(data.server ?? "server")}/${String(data.tool ?? "tool")} completed.`;
  }
  return `${envelope.meta.tool} succeeded.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
