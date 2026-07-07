# Codex Handoff

## Goal

Allow ChatGPT to hand off implementation work to local Codex without turning the MCP server into a direct host write/edit or host shell surface.

## Flow

```text
ChatGPT
  -> MCP codex_task_create
  -> .secure-mcp/codex-tasks/tasks/<task>.json
  -> local codex-worker
  -> codex exec in the workspace
  -> task status/log update
  -> MCP codex_task_status / codex_task_tail
```

## Design choices

- Handoff is disabled by default.
- Enabling handoff adds only `codex_task_*` tools.
- The MCP request creates or inspects task records; it does not run Codex inline.
- A local user-controlled worker process claims queued tasks and runs Codex.
- Task queues and logs stay under `.secure-mcp/`, which normal file tools block.
- The default worker runs `codex exec --sandbox workspace-write --ask-for-approval never --json -`.

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
