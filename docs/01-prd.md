# PRD: Secure MCP Runtime v1

## Objective

Create a minimal MCP runtime that provides safe project context and sandboxed command execution for ChatGPT/Codex workflows.

The runtime replaces the high-risk part of broad local-agent systems: remote-accessible host shell.

## Users

- Developer using ChatGPT as a codebase reader/reviewer/planner
- Developer using Codex as final local executor/verifier
- Security-conscious user who wants model-assisted local development without exposing host shell

## Core promise

```text
The MCP client can read project context and execute commands only inside a configured Docker sandbox.
```

## Tool surface

MVP tools:

```text
read_file
list_directory
grep_files
find_files
exec_container
sandbox_status
```

Optional v1.1 tools:

```text
sandbox_start
sandbox_stop
workspace_info
audit_log_tail
```

Out of scope:

```text
write_file
edit_file
run_shell
host_exec
arbitrary_docker
browser automation
credential access
```

## Security constraints

- Host filesystem access is read-only.
- Host filesystem access is limited to a single workspace root.
- Command execution is allowed only through Docker sandbox.
- Docker runtime settings are controlled by trusted config, not tool input.
- The sandbox should have no network by default.
- No Docker socket mount.
- No host HOME, SSH, browser, or cloud credential mounts.
- Audit logs are enabled by default.

## Success metrics

- No host shell code path exists for model commands.
- Path traversal and symlink escape are tested and blocked.
- Tool list does not expose forbidden capabilities.
- Sandbox command execution passes controlled tests.
- Security documentation is clear enough for a user to understand the residual risk.
