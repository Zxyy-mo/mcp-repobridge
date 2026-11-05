# Acceptance Criteria

## Tool exposure

- [ ] `tools/list` includes `read_file`.
- [ ] `tools/list` includes `read_files`.
- [ ] `tools/list` includes `list_directory`.
- [ ] `tools/list` includes `grep_files`.
- [ ] `tools/list` includes `find_files`.
- [ ] `tools/list` includes `project_task_list` and `project_task_run`.
- [ ] `tools/list` includes `exec_container`.
- [ ] `tools/list` includes `sandbox_status`.
- [ ] `tools/list` includes `sandbox_start`.
- [ ] `tools/list` includes `sandbox_stop`.
- [ ] `tools/list` includes `sandbox_task_status`, `sandbox_task_tail`, and `sandbox_task_cancel`.
- [ ] `tools/list` includes `workspace_bootstrap`.
- [ ] `tools/list` includes `workspace_info`.
- [ ] `tools/list` includes `audit_log_tail`.
- [ ] `tools/list` does not include `run_shell`.
- [ ] `tools/list` does not include `host_exec`.
- [ ] `tools/list` does not include `write_file`.
- [ ] `tools/list` does not include `edit_file`.
- [ ] `tools/list` does not include arbitrary Docker tools.
- [ ] Extension tools are absent by default.
- [ ] Enabling document Skills does not expose `mcp_call` until host MCP execution is separately enabled.

## Extension gateway

- [ ] Skill discovery opens only configured `SKILL.md` files without following file symlinks.
- [ ] Skill reads require the discovered content revision and are byte-bounded.
- [ ] Skill metadata explicitly reports `execution: none` and untrusted instruction content.
- [ ] The client cannot provide a host MCP command, args, cwd, or environment.
- [ ] MCP discovery filters upstream tools through the configured allowlist.
- [ ] Wildcard upstream tool access is rejected and host process concurrency is capped.
- [ ] MCP calls require a non-expired discovery ID and matching schema revision.
- [ ] Host environment values are passed only through configured safe keys/mappings.
- [ ] MCP tool counts, discovery/call time, and returned bytes are bounded.
- [ ] Audit records contain upstream argument keys but not values.

## Path policy

- [ ] Relative paths inside workspace are allowed.
- [ ] Absolute paths inside workspace are allowed only after normalization.
- [ ] `../` traversal is rejected.
- [ ] Absolute paths outside workspace are rejected.
- [ ] Symlinks pointing outside workspace are rejected.
- [ ] Secret-like files are blocked by default: `.env`, SSH keys, cloud credentials.
- [ ] Huge files require range/limit or are truncated safely.

## File tools

- [ ] `read_file` reads text files inside workspace.
- [ ] `read_file` respects `offset` and `limit`.
- [ ] `read_file` returns total bytes and the next offset, plus whole-file SHA-256 within a configured hash budget.
- [ ] `read_files` enforces item and aggregate byte budgets and isolates per-file errors.
- [ ] `list_directory` limits result count.
- [ ] List/search cursors are stable and cannot be reused with changed query input.
- [ ] `grep_files` does not search outside workspace.
- [ ] `grep_files` excludes `.git`, `node_modules`, `dist`, `build`, `coverage` by default.
- [ ] `find_files` caps result count.

## Exec policy

- [ ] `exec_container("pwd")` returns `/workspace` or a workspace subdirectory.
- [ ] `exec_container("whoami")` returns non-root user when configured.
- [ ] `exec_container("sleep 999")` times out.
- [ ] `exec_container("yes")` is output-capped.
- [ ] A command beyond the yield window becomes a durable task rather than blocking the MCP call.
- [ ] Durable task logs support offset reads; timeout/cancel terminates the process group.
- [ ] `exec_container("curl https://example.com")` is rejected by policy or fails due to network none.
- [ ] `exec_container("docker ps")` is rejected or unavailable.
- [ ] `exec_container("cat ~/.ssh/id_rsa")` fails because no host secret is mounted.
- [ ] `exec_container("rm -rf /")` is rejected by policy and/or constrained by read-only rootfs.

## Docker sandbox

- [ ] Sandbox starts with a fixed trusted container name.
- [ ] Sandbox defaults to `--network none`.
- [ ] Sandbox uses `--cap-drop=ALL`.
- [ ] Sandbox uses `--security-opt no-new-privileges`.
- [ ] Sandbox uses `--read-only` root filesystem.
- [ ] Sandbox uses memory/cpu/pids limits.
- [ ] Sandbox does not mount `/var/run/docker.sock`.
- [ ] Sandbox does not mount `$HOME`.
- [ ] Sandbox does not mount `~/.ssh`.
- [ ] Sandbox never mounts the configured host workspace directly.
- [ ] Sandbox receives a managed writable copy with secret-like paths omitted.
- [ ] Writes inside the sandbox do not change the host workspace.
- [ ] The managed copy is removed when the sandbox stops.

## Flow and task reliability

- [ ] Every tool returns a stable structured result envelope and request ID.
- [ ] Failures have stable error codes and recovery hints where applicable.
- [ ] `workspace_bootstrap` reports sandbox/worker readiness and the next setup action.
- [ ] Project task discovery does not expose package script bodies.
- [ ] Codex task creation supports durable idempotency keys.
- [ ] Codex tasks capture relevant-file and Git baselines before queueing.
- [ ] The Codex worker publishes a TTL-bound heartbeat and detects context drift.
- [ ] Running Codex tasks can be canceled and final results summarize workspace changes.

## HTTP transport, if implemented

- [ ] Default bind address is `127.0.0.1`.
- [ ] Missing bearer token returns 401.
- [ ] Invalid bearer token returns 401.
- [ ] Bad Origin returns 403.
- [ ] Tunnel is external, not automatically always-on.

## Documentation

- [ ] README describes objective, tool surface, and startup.
- [ ] SECURITY.md explains threat model and residual risks.
- [ ] Docs clearly state Docker is risk reduction, not perfect isolation.
- [ ] Docs explain why host `run_shell` is not provided.
