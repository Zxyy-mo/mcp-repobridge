# Architecture

## High-level flow

```text
ChatGPT / MCP Client
        |
        | MCP request
        v
MCP RepoBridge
        |
        |-- read/list/grep/find --> Host filesystem, read-only, workspace restricted
        |
        |-- exec_container ------> Docker exec into fixed sandbox container
```

## Components

### MCP Server

Responsible for:

- transport setup
- tool registration
- auth middleware if HTTP transport is enabled
- request routing
- error formatting

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
- `list_directory`
- `grep_files`
- `find_files`

### Sandbox Layer

Responsible for Docker lifecycle and execution.

Must not allow the model to choose Docker CLI flags.

Trusted config controls:

- container name
- image
- workspace mount path
- network mode
- memory/cpu/pids limits
- user
- read-only rootfs
- tmpfs

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
  truncated: boolean;
  bytesRead: number;
}
```

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
  entries: Array<{ name: string; type: "file" | "directory" | "symlink" | "other"; size?: number }>;
  truncated: boolean;
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
}
```

### find_files

Input:

```ts
{
  pattern: string;
  path?: string;
  maxResults?: number;
}
```

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
