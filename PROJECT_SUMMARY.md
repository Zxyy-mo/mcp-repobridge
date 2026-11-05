# Project Summary

## Problem

Broad local AI development runtimes often provide file read/write/edit, grep/find/list, and shell execution. This is useful for agentic development, but it is not ideal as a security boundary when exposed through MCP and tunnel-based access.

The most concerning capability is host shell execution. A workspace `cwd` is not a sandbox. A shell command can change directories, read user-accessible files, invoke network tools, run package manager scripts, and generally do anything the host user can do unless separately constrained by the operating system.

## Proposed solution

Build a minimal MCP runtime that exposes only:

- read-only host file tools restricted to a workspace root
- Docker-only command execution through a fixed sandbox container

## Key design choice

Do not fork a broad local runtime as the default path. Use existing projects only as workflow references, then implement a smaller security-first runtime.

## Why this is safer

Instead of:

```text
MCP client -> run_shell -> host shell
```

use:

```text
MCP client -> exec_container -> docker exec -> sandbox shell
```

The Docker sandbox is configured with:

- network disabled by default
- no Docker socket mount
- no HOME/SSH/cloud credential mounts
- non-root user
- read-only container root filesystem
- dropped Linux capabilities
- no-new-privileges
- resource limits
- fixed workspace mount only

## Remaining risks

This is risk reduction, not perfect security. If workspace is mounted read-write, the sandbox can still change or delete project files. If network is enabled later, exfiltration risk returns. Docker is not a perfect VM boundary. The runtime must document these tradeoffs clearly.
