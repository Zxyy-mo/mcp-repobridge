# Codex Handoff

## Goal

Allow ChatGPT to hand off implementation work to local Codex without turning the MCP server into a direct host write/edit or host shell surface.

## Flow

```text
ChatGPT
  -> MCP codex_task_create
  -> .secure-mcp/codex-tasks/tasks/<task>.json
  -> local codex-worker
  -> baseline/context-drift check
  -> codex exec in the workspace
  -> durable status/log/result update
  -> MCP codex_task_status / codex_task_tail
```

## Design choices

- Handoff is disabled by default.
- Enabling handoff adds only `codex_task_*` tools.
- The MCP request creates or inspects task records; it does not run Codex inline.
- A local user-controlled worker process claims queued tasks and runs Codex.
- Task queues and logs stay under `.secure-mcp/`, which normal file tools block.
- The default worker runs `codex exec --sandbox workspace-write --ask-for-approval never --json -`.
- The worker child process receives only configured allowlisted environment keys/prefixes.
- Secret-like environment variable names are stripped even when they match the allowlist.
- Optional idempotency keys make client retries return the original task; reuse
  with different task input is rejected.
- Creation captures Git state and hashes/metadata for explicitly relevant files.
- The worker publishes heartbeat records with a short TTL so clients can report
  whether task execution is currently available.
- Relevant-file context drift fails closed by default before Codex is launched.
- Queued tasks cancel immediately; running tasks use a cancellation request and
  worker-side process-group termination.
- Final task results record changed files, pre-existing changes, Git diff stats,
  context drift, cancellation, exit status, and timing.
- Task logs use byte offsets so clients can follow them without rereading output.

## Operational model

Run the bridge with:

```bash
npm run --silent bridge -- start --project-root /absolute/path/to/project --codex-handoff true
```

Run the worker with:

```bash
npm run --silent codex-worker -- --config /absolute/path/to/project/.secure-mcp/runtime.config.json
```

Use `--once` when you want a single explicit task execution.

For retryable callers, send a stable `idempotencyKey` with
`codex_task_create`. Use the returned `nextAction`, then follow `codex_task_tail`
from its `nextOffset` while the task is running. A worker heartbeat is
operational evidence only; it is not authorization to enable handoff.
