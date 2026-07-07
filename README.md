# MCP RepoBridge

> A guarded MCP bridge for repository context, Docker-sandboxed commands, and
> optional Codex handoff.

[简体中文](README.zh-CN.md)

MCP RepoBridge lets ChatGPT and other MCP clients inspect a project workspace
without giving them a host shell.

It exposes a small set of read-only repository tools, routes command execution
through a fixed Docker sandbox, and can optionally hand implementation work off
to a local Codex worker. It is intentionally smaller than a general agent
framework: it is the bridge between an LLM interface and a repository, not a
replacement for your development environment.

## Why This Exists

This project came from a pragmatic workflow:

- ChatGPT's web UI is good for interactive reading, questioning, and planning.
- Codex is better suited for longer implementation work.
- Their usage limits and working modes are separate enough that it is useful to
  let ChatGPT inspect a repository without spending Codex work on every small
  question.
- Exposing a normal local shell to a remote LLM is too much trust.

MCP RepoBridge sits in the middle. ChatGPT can read and search the project via
MCP, run bounded checks inside Docker, and, when explicitly enabled, queue tasks
for Codex to handle separately.

```text
ChatGPT / MCP client
        |
        | HTTPS + bearer token
        v
MCP RepoBridge
        |
        |-- read-only workspace file tools
        |
        |-- Docker sandbox command execution
        |
        |-- optional Codex task queue
```

The result is a small, auditable MCP server for people who want the convenience
of "connect MCP and start working" without handing an LLM direct access to the
host machine.

## What It Provides

Default MCP tools:

```text
read_file
list_directory
grep_files
find_files
exec_container
sandbox_status
sandbox_start
sandbox_stop
workspace_info
audit_log_tail
```

Optional Codex handoff tools:

```text
codex_task_create
codex_task_list
codex_task_status
codex_task_tail
codex_task_cancel
```

What it deliberately does not provide:

```text
run_shell
host_exec
write_file
edit_file
arbitrary_docker
```

## Security Model

MCP RepoBridge assumes the MCP client and the model may make unsafe requests.
The runtime enforces boundaries in code rather than relying on prompts.

Key defaults:

- host shell execution is not exposed
- host write/edit tools are not exposed
- file access is restricted to a configured workspace root
- path traversal and symlink escapes are rejected
- secret-like paths such as `.env`, `.ssh`, `.aws`, `.gcloud`, and `.secure-mcp`
  are blocked by default
- command execution goes through `docker exec` into a fixed container
- the model cannot choose Docker flags, container name, image, or mounts
- the default sandbox has `--network none`
- the default sandbox does not mount host HOME, SSH keys, cloud credentials, or
  the Docker socket
- command policy rejects common network, Docker, privilege escalation, and
  destructive commands
- every tool call is audited

Docker is risk reduction, not perfect isolation. Read [SECURITY.md](SECURITY.md)
and [docs/threat-model.md](docs/threat-model.md) before exposing the
runtime through a public tunnel.

## Quick Start

Install and build:

```bash
npm install
npm test
npm run build
```

Build the default sandbox image:

```bash
docker build -f docker/Dockerfile.sandbox -t secure-mcp-sandbox:latest docker
```

Start the bridge for a project:

```bash
npm run --silent bridge -- start \
  --project-root /absolute/path/to/project \
  --tunnel none
```

Stop it:

```bash
npm run --silent bridge -- stop \
  --project-root /absolute/path/to/project
```

The bridge writes generated state under:

```text
<project-root>/.secure-mcp/
```

That directory contains runtime config, bearer tokens, logs, audit records, and
optional Codex task state. It is ignored by git and blocked by the file tools.

## ChatGPT Setup

For ChatGPT or another remote MCP client, start the HTTP runtime with a tunnel.

Cloudflare Quick Tunnel:

```bash
npm run --silent bridge -- start \
  --project-root /absolute/path/to/project \
  --tunnel cloudflare
```

Managed tunnel or reverse proxy:

```bash
npm run --silent bridge -- start \
  --project-root /absolute/path/to/project \
  --tunnel external \
  --public-base-url https://mcp.example.com
```

The command prints:

```text
publicMcpUrl
token
```

In ChatGPT, configure:

```text
URL: publicMcpUrl
Authentication: Access token / API key
Header scheme: Bearer
Token: token value only
```

Do not put `Bearer ` into the token field if the UI already has a Bearer/header
scheme option. The HTTP header must end up as:

```text
Authorization: Bearer <token>
```

For a Linux server deployment flow, see
[docs/linux-server-tunnel.md](docs/linux-server-tunnel.md).

## Docker Sandbox

The default sandbox image is intentionally small. It is based on Node and
includes:

```text
node
npm
bash
git
ripgrep
ca-certificates
```

It does not try to be a full polyglot development image. If a project needs
Python, Go, Rust, or another toolchain, build a trusted image and select it from
local configuration:

```json
{
  "sandbox": {
    "image": "secure-mcp-sandbox:latest"
  }
}
```

The MCP client must not be allowed to choose image names, Docker flags, mount
paths, network mode, or container names.

## Optional Codex Handoff

Codex handoff is disabled by default.

When enabled, ChatGPT can queue structured tasks through MCP. A separate local
or server-side worker claims the tasks and runs Codex in the workspace.

Start the bridge with handoff tools:

```bash
npm run --silent bridge -- start \
  --project-root /absolute/path/to/project \
  --tunnel none \
  --codex-handoff true
```

Run the worker in another terminal:

```bash
npm run --silent codex-worker -- \
  --config /absolute/path/to/project/.secure-mcp/runtime.config.json
```

Default worker command:

```text
codex exec --sandbox workspace-write --ask-for-approval never --json -
```

Use this only when you explicitly want Codex to modify the workspace. The MCP
request itself only creates or inspects task records.

## Configuration

Start from:

```text
examples/config.example.json
```

Important defaults:

- HTTP server binds to `127.0.0.1`
- sandbox network is `none`
- workspace mount mode is `ro`
- root filesystem is read-only
- Linux capabilities are dropped
- `no-new-privileges` is enabled
- memory, CPU, PID, timeout, and output limits are configured
- audit logging is enabled

## Development

```bash
npm install
npm run lint
npm test
npm run build
```

Useful docs:

- [docs/architecture.md](docs/architecture.md)
- [docs/threat-model.md](docs/threat-model.md)
- [docs/codex-handoff.md](docs/codex-handoff.md)
- [docs/linux-server-tunnel.md](docs/linux-server-tunnel.md)
- [README.zh-CN.md](README.zh-CN.md)
- [docs/zh-CN-guide.md](docs/zh-CN-guide.md)

## Status

MCP RepoBridge is an early `0.1.x` project. The core runtime, HTTP transport,
Docker sandbox lifecycle, bridge adapter, and optional Codex handoff flow are in
place.

The project is useful today, but interfaces and deployment guidance may evolve
as it is tested against more real repositories and MCP clients.

## License

Apache-2.0. See [LICENSE](LICENSE).
