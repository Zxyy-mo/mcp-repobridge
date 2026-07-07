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

If workspace is mounted read-write, commands can delete or modify project files.

Mitigation:

- default to read-only mode for review
- require explicit rw mode for build/test/patch workflows
- advise use of clean worktree or copy
- audit destructive command attempts

## Residual risk

Docker is not a perfect security boundary. This runtime reduces blast radius compared to host shell, but users should still avoid mounting secrets or enabling network unless needed.

## Security principle

Treat the MCP client and model as untrusted agents. Expose minimal capabilities and enforce boundaries in code, not prompts.
