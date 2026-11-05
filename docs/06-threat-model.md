# Threat Model

## Assets to protect

- host filesystem outside workspace
- host shell access
- SSH keys
- cloud credentials
- environment secrets
- browser profile data
- Docker daemon
- network access for data exfiltration
- project source code integrity

## Threat actors

- malicious or compromised MCP client
- prompt-injected model session
- malicious repository content that convinces the agent to run dangerous commands
- exposed tunnel endpoint with stolen token
- supply-chain scripts inside the project

## Main risks

### Host shell RCE

If a remote MCP client can call host `run_shell`, it can execute commands with the permissions of the user running the bridge. This is the primary risk this design removes.

Mitigation:

- no host run_shell tool
- no host shell execution code path for model commands
- Docker-only exec

### Path traversal

A model may request `../` or absolute paths to read secrets outside workspace.

Mitigation:

- normalize paths
- realpath checks
- workspace root enforcement
- symlink escape tests

### Secret file reads inside workspace

Some secrets may live inside workspace, such as `.env`.

Mitigation:

- secret-like denylist by default
- explicit configuration required to allow
- audit logging

### Network exfiltration

Commands could upload source or secrets.

Mitigation:

- Docker network none by default
- command denylist for common network tools
- no secret mounts

### Docker breakout / daemon control

Mounting Docker socket gives the container high control over host Docker daemon.

Mitigation:

- never mount `/var/run/docker.sock`
- do not provide Docker CLI in sandbox image by default
- deny docker/podman commands

### Project destruction

Build/test commands need a writable tree, but mounting the real workspace
read-write would let an injected command delete or modify project files.

Mitigation:

- never mount the configured host workspace into the final sandbox
- create a filtered disposable copy and mount only that copy read-write
- omit secret-like paths from the copy using the same runtime path policy
- delete the managed copy during sandbox stop
- audit destructive command attempts

Residual risk: sandbox commands can still corrupt their disposable copy and can
consume resources up to configured Docker/task limits. Codex handoff is a
separate, explicitly enabled path that can write the host workspace.

### Stale or duplicate Codex work

A client retry could queue the same implementation twice, or a queued task could
run after its relevant files have changed.

Mitigation:

- optional durable idempotency keys
- relevant-file SHA-256 and Git baseline captured at creation
- fail closed on relevant-file context drift by default
- worker heartbeat and persistent status/log records
- cooperative cancellation of queued and running work

### Trusted host MCP supply chain

An explicitly configured stdio MCP server runs as a native child process with
the same OS account as RepoBridge. A malicious executable can access anything
that account can access even if its tools and environment are filtered.

Mitigation:

- extension and host MCP execution are separately disabled by default
- command, args, cwd, environment mappings, and tool allowlists are local trusted configuration, never model input
- upstream tool calls require a short-lived discovery ID and matching schema revision
- only allowlisted tool descriptors are returned and callable
- child environment is reduced and result/time/tool-count budgets are enforced
- wildcard tool access is rejected and concurrent child processes are capped
- document Skills never execute code and Skill file symlinks are not followed

Residual risk: these controls constrain the remote client's interface; they do
not sandbox the configured executable. Review and pin local MCP programs as
carefully as any other host dependency. Keep `hostMcpEnabled` false if that
trust is not acceptable.

## Residual risk

Docker is not a perfect security boundary. This runtime reduces blast radius compared to host shell, but users should still avoid mounting secrets or enabling network unless needed.

## Security principle

Treat the MCP client and model as untrusted agents. Expose minimal capabilities and enforce boundaries in code, not prompts.
