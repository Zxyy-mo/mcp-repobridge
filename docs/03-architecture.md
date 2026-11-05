# Architecture

## High-level flow

```text
ChatGPT / MCP Client
        |
        | MCP request
        v
Secure MCP Runtime
        |
        |-- read/list/grep/find/batch --> Host filesystem, read-only, workspace restricted
        |
        |-- snapshot filter --> Disposable writable copy --> Fixed Docker sandbox
        |
        |-- project tasks / durable sandbox tasks
        |
        |-- optional document Skills / trusted host stdio MCP processes
        |
        |-- optional durable queue --> Local Codex worker
```

## Components

### MCP Server

Responsible for:

- transport setup
- tool registration
- auth middleware if HTTP transport is enabled
- request routing
- stable result envelopes and recovery hints

### Policy Layer

Responsible for:

- path validation
- symlink escape prevention
- tool exposure control
- command policy
- timeout/output limits
- secret-like path blocking

### File Tools

Use host filesystem, but only for read-only access within workspace root.

Tools:

- `read_file`
- `read_files`
- `list_directory`
- `grep_files`
- `find_files`

Reads expose byte offsets and whole-file SHA-256 values within a configured hash
budget (larger files report that hashing was skipped). Batch reads enforce both
item and aggregate byte budgets. Listings and searches use query-bound,
opaque continuation cursors so a cursor cannot be reused with different input.

### Sandbox Layer

Responsible for Docker lifecycle and execution.

Must not allow the model to choose Docker CLI flags.

Trusted config controls:

- container name
- image
- in-container workspace target path
- network mode
- memory/cpu/pids limits
- user
- read-only rootfs
- tmpfs

The configured host workspace is never mounted in the final sandbox. On start,
RepoBridge creates a managed temporary copy, applies the same secret-like path
policy used by host file tools, and mounts that copy read-write. Sandbox writes
are therefore useful for builds and checks but cannot modify the host workspace;
the copy is deleted when the sandbox stops. Legacy `defaultMountMode` remains
`ro` for configuration compatibility and `rw` is rejected.

The image field is the extension point for language-specific sandboxes. The
default image should remain small and security-focused; project owners may build
trusted variants with Python, Go, Rust, or other toolchains preinstalled. The MCP
client must not be able to choose the image, Docker flags, mounts, container
name, or network mode at call time.

Network remains `none` by default even for language-specific images. Dependency
installation that requires network access belongs in a trusted build step, a
prebuilt image, or the optional local Codex handoff workflow rather than direct
MCP execution.

### Audit Layer

Records:

- timestamp
- tool name
- sanitized input summary
- decision allow/deny
- duration
- exit code if applicable
- stdout/stderr byte counts

Do not log full secret-like file contents.

### Extension Gateway

Extension tools have two independent configuration gates. Document Skills are
regular `SKILL.md` files opened without following file symlinks, hashed at
discovery, and read only with the matching revision. They are returned as
untrusted instructions and have no execution path.

Host MCP execution has an additional explicit gate. The client selects only a
configured server name; command, args, cwd, environment mappings, and tool
allowlist remain server-side. Discovery starts that exact stdio process, filters
`tools/list`, creates a short-lived in-memory lease over the schemas, and
`mcp_call` accepts only a tool in the matching lease/revision. Each operation is
one-shot and closes the child process afterward. Responses, tool counts,
connection time, and call time are bounded.

This path is intentionally outside Docker: configured MCP executables are
trusted host programs. The gateway constrains the remote model's authority but
does not sandbox the executable itself.

## Tool design

### read_file

Input:

```ts
{
  path: string;
  offset?: number;
  limit?: number;
}
```

Output:

```ts
{
  path: string;
  content: string;
  encoding: "utf8";
  truncated: boolean;
  bytesRead: number;
  offset: number;
  nextOffset?: number;
  totalBytes: number;
  sha256?: string;
  hashStatus: "complete" | "skipped_size_limit";
}
```

### read_files

Accepts several `{ path, offset?, limit? }` requests and returns per-file
success/error records under configured aggregate item and byte budgets.

### list_directory

Input:

```ts
{
  path: string;
  limit?: number;
}
```

Output:

```ts
{
  path: string;
  cursor?: string;
  entries: Array<{ name: string; type: "file" | "directory" | "symlink" | "other"; size?: number }>;
  truncated: boolean;
  nextCursor?: string;
}
```

### grep_files

Input:

```ts
{
  pattern: string;
  path?: string;
  include?: string[];
  exclude?: string[];
  maxMatches?: number;
  cursor?: string;
}
```

### find_files

Input:

```ts
{
  pattern: string;
  path?: string;
  maxResults?: number;
  cursor?: string;
}
```

Short commands return inline. Commands still running after `yieldMs` are
accepted as durable tasks. `sandbox_task_status`, `sandbox_task_tail`, and
`sandbox_task_cancel` operate on persisted metadata/logs and terminate the
container process group on timeout or cancellation.

### project tasks

`project_task_list` discovers conventional package-manager, Go, Cargo, Python,
and Make targets. Only validated names and metadata are exposed; script bodies
are not returned. `project_task_run` resolves the chosen name server-side and
then uses the same command and sandbox policies as `exec_container`.

### workspace bootstrap

`workspace_bootstrap` combines project markers, languages, Git HEAD, sandbox
readiness, discovered tasks, Codex worker heartbeat, and a structured
`nextAction` into one first-contact call.

## Result contract

Every tool call returns a structured envelope:

```ts
{
  status: "succeeded" | "accepted" | "failed";
  data?: unknown;
  meta: { requestId: string; tool: string; durationMs: number };
  nextAction?: { tool: string; arguments: object; reason: string };
  error?: { code: string; category: string; message: string; retryable: boolean };
}
```

The text content stays compact while the full payload is available as MCP
structured content.

### exec_container

Input:

```ts
{
  command: string;
  workdir?: string;
  timeoutMs?: number;
}
```

Execution:

```ts
spawn("docker", [
  "exec",
  "-i",
  "--workdir",
  safeContainerWorkdir,
  configuredContainerName,
  "bash",
  "-lc",
  command
], { shell: false, env: minimalEnv })
```

Never use:

```ts
exec(`docker exec ${containerName} bash -lc "${command}"`)
```

## Transport strategy

Phase 1:

- stdio transport for local agent integration

Phase 2:

- Streamable HTTP transport
- bind `127.0.0.1` by default
- bearer token authentication
- Origin validation
- tunnel handled externally
