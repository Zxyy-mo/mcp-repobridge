# MCP RepoBridge

> A guarded MCP bridge for repository context, Docker-sandboxed commands,
> document Skills, trusted local MCP servers, and optional Codex handoff.

[简体中文](README.zh-CN.md)

MCP RepoBridge lets ChatGPT and other MCP clients inspect a project workspace
without giving them a host shell.

It exposes a small set of read-only repository tools, routes command execution
through a fixed Docker sandbox backed by a filtered disposable workspace, and
can optionally hand implementation work off to a local Codex worker. It is
intentionally smaller than a general agent
framework: it is the bridge between an LLM interface and a repository, not a
replacement for your development environment.

> [!IMPORTANT]
> **Project status (November 2026) — expected final release.** ChatGPT and
> Codex usage quotas are set to be merged in December 2026. Once they share a
> single pool, the main reason this bridge exists — letting ChatGPT inspect a
> repo while Codex quota stays separate — goes away, so the project's
> practical value under ChatGPT will be limited. The repository stays
> available as-is; no further updates are planned.

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
        |-- read-only host workspace file tools
        |
        |-- filtered disposable copy -> Docker sandbox execution
        |
        |-- optional document Skills / trusted host MCP gateway
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
read_files
list_directory
grep_files
find_files
project_task_list
project_task_run
exec_container
sandbox_status
sandbox_start
sandbox_stop
sandbox_task_status
sandbox_task_tail
sandbox_task_cancel
workspace_bootstrap
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

Optional extension tools:

```text
extension_discover
skill_read
mcp_call              # only when trusted host MCP execution is enabled
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
- the final container receives a filtered, disposable workspace copy instead
  of the host workspace; secret-like paths are omitted and writes are discarded
- the model cannot choose Docker flags, container name, image, or mounts
- the default sandbox has `--network none`
- the default sandbox does not mount host HOME, SSH keys, cloud credentials, or
  the Docker socket
- command policy rejects common network, Docker, privilege escalation, and
  destructive commands
- HTTP transport enforces Origin and Host allowlists
- HTTP MCP sessions have a configured cap and idle TTL
- Codex worker child processes receive an allowlisted, secret-filtered
  environment
- extension support and host MCP execution are separate, disabled-by-default
  gates
- Skills are treated as untrusted Markdown instructions and are never executed
- host MCP commands, arguments, working directory, environment mappings, and
  tool allowlists come only from trusted local configuration
- an MCP call must use a short-lived discovery ID and matching schema revision
- host MCP child-process concurrency is capped and wildcard tool access is rejected
- every tool call is audited
- every tool result uses a stable status/data/error/next-action envelope

Docker is risk reduction, not perfect isolation. Read [SECURITY.md](SECURITY.md)
and [docs/06-threat-model.md](docs/06-threat-model.md) before exposing the
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
[docs/11-linux-server-tunnel.md](docs/11-linux-server-tunnel.md).

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
util-linux
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

Commands that finish within the configured yield window return inline. Longer
commands become durable `sandbox_task_*` jobs with incremental log reads and
cooperative cancellation. `project_task_list` discovers conventional project
tasks without exposing package-script bodies, and `project_task_run` resolves
the selected task server-side before applying the normal command policy.

## Optional Skills and Local MCP Servers

The extension gateway is disabled by default. It adds a low-round-trip flow
similar to local MCP/Skill aggregators while preserving two separate trust
levels:

- document Skills scan configured directories and return bounded `SKILL.md`
  content; no Skill script or runtime is executed
- local MCP servers start an exact stdio command from trusted configuration on
  the host, discover its allowlisted tools, then proxy a revision-bound call

Copy [examples/extensions.example.json](examples/extensions.example.json), edit
the absolute paths and allowlists, then start with:

```bash
npm run --silent bridge -- start \
  --project-root /absolute/path/to/project \
  --tunnel none \
  --extensions-config /absolute/path/to/extensions.json
```

The example enables document Skills but keeps `hostMcpEnabled` false. Change it
to true only after reviewing every configured executable, argument, tool
allowlist, and environment mapping.

The client workflow is:

```text
extension_discover(kind=skill) -> extension_discover(name=...) -> skill_read(revision=...)
extension_discover(kind=mcp)   -> extension_discover(name=...) -> mcp_call(discoveryId, revision, tool, arguments)
```

The model cannot pass a process command, arguments, cwd, or environment through
any MCP tool. Environment values are copied only by locally configured variable
name mappings, and audit records store argument names rather than values.
Upstream tool metadata and results are explicitly labeled as untrusted content.

Important: an enabled local MCP server is trusted native host code. It runs with
the OS privileges of RepoBridge and is outside the Docker sandbox. Tool
allowlists and environment filtering reduce exposure to the model; they do not
sandbox a malicious MCP executable.

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
request itself only creates or inspects task records. The worker child process
does not inherit the full host environment; only configured safe keys/prefixes
are passed through, and secret-like variable names are stripped.

Task creation supports idempotency keys and captures the relevant-file/Git
baseline. The worker publishes a heartbeat, refuses stale relevant-file context
by default, supports running-task cancellation, and records changed files,
pre-existing changes, and a diff summary in the final result.

## Configuration

Start from:

```text
examples/config.example.json
examples/extensions.example.json
```

Important defaults:

- HTTP server binds to `127.0.0.1`
- sandbox network is `none`
- the host workspace is not mounted into the final sandbox; a filtered,
  disposable copy is writable so builds can create temporary outputs
- root filesystem is read-only
- Linux capabilities are dropped
- `no-new-privileges` is enabled
- memory, CPU, PID, timeout, and output limits are configured
- audit logging is enabled

For a low-round-trip client flow, call `workspace_bootstrap` first. File list
and search tools return opaque cursors, `read_files` applies aggregate budgets,
and every result includes a structured `nextAction` when continuation or setup
is needed.

## Development

```bash
npm install
npm run lint
npm test
npm run build
```

Optional Docker e2e:

```bash
npm run test:e2e
```

This requires Docker and runs only the gated Docker sandbox e2e suite. Normal
`npm test` keeps that suite skipped.

Useful docs:

- [docs/03-architecture.md](docs/03-architecture.md)
- [docs/04-acceptance.md](docs/04-acceptance.md)
- [docs/05-review-checklist.md](docs/05-review-checklist.md)
- [docs/06-threat-model.md](docs/06-threat-model.md)
- [docs/10-codex-handoff.md](docs/10-codex-handoff.md)
- [docs/11-linux-server-tunnel.md](docs/11-linux-server-tunnel.md)
- [README.zh-CN.md](README.zh-CN.md)
- [docs/12-中文使用指南.md](docs/12-中文使用指南.md)

## Status

MCP RepoBridge is an early `0.1.x` project. The core runtime, HTTP transport,
Docker sandbox lifecycle, document Skill/trusted host MCP gateway, bridge
adapter, and optional Codex handoff flow are in place.

The project is useful today, but interfaces and deployment guidance may evolve
as it is tested against more real repositories and MCP clients.

## License

Apache-2.0. See [LICENSE](LICENSE).
