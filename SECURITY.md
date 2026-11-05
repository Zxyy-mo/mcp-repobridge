# Security Policy

## Core boundary

This project does not expose a general host shell. Model-provided shell commands
must go through `exec_container`, which runs them inside a fixed Docker sandbox
backed by a filtered disposable workspace copy.

Two explicitly enabled host-side workflows are separate from that Docker
boundary:

- Codex handoff queues work for a separately started local worker.
- The extension gateway may start exact stdio MCP commands from trusted local
  configuration. The remote client can select only configured servers and
  allowlisted tools; it cannot provide the executable, arguments, working
  directory, environment, or process flags.

Document Skills are read as bounded, revision-bound, untrusted Markdown. Skill
scripts are never executed.

## What this protects

- host shell
- host filesystem outside workspace
- common secret locations
- Docker daemon socket
- default network access from executed commands
- remote selection of host commands, process arguments, environment, or
  wildcard MCP tool access

## What this does not fully protect

- vulnerabilities in trusted host MCP executables; these run outside Docker
  with the OS privileges of the RepoBridge process
- host resources that an explicitly trusted MCP executable can access directly
- malicious commands run inside sandbox
- Docker runtime vulnerabilities
- secrets deliberately placed inside workspace and explicitly allowed
- network exfiltration if network is enabled by configuration
- host workspace modification by an explicitly enabled Codex worker

Host MCP execution and the extension gateway are disabled independently by
default. Tool allowlists, minimal environment forwarding, discovery revisions,
timeouts, result budgets, process limits, and audit logging constrain what the
remote model can request, but they do not sandbox a malicious local executable.
Review and pin every configured MCP server as a trusted host dependency.

## Reporting security issues

Until this project has a published disclosure process, report privately to the maintainer.
