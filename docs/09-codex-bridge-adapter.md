# Bridge Adapter

MCP RepoBridge includes a small adapter that can start the runtime, manage local state, and optionally coordinate a tunnel.

## Desired adapter behavior

Reference workflow:

```text
local script -> configure MCP runtime -> serve -> tunnel -> ChatGPT
```

MCP RepoBridge flow:

```text
bridge script -> configure MCP RepoBridge -> serve -> tunnel -> ChatGPT
```

## Inputs needed from bridge script

- project root
- runtime config path
- token environment variable
- transport mode
- public URL or local URL
- start/stop/status/rotate commands

## Security note

The adapter must not add host shell tools back into the runtime. The adapter is orchestration only. Security enforcement belongs in MCP RepoBridge.

## Implemented local adapter

This repository includes a cross-platform Node adapter:

```bash
npm run --silent bridge -- start --project-root /absolute/path/to/project --tunnel none
npm run --silent bridge -- status --project-root /absolute/path/to/project
npm run --silent bridge -- stop --project-root /absolute/path/to/project
npm run --silent bridge -- rotate --project-root /absolute/path/to/project
```

Tunnel modes:

- `none` / `local`: reports the local `http://127.0.0.1:<port>/mcp` URL.
- `external`: records a caller-provided `--public-base-url`.
- `cloudflare`: starts `cloudflared tunnel --url http://127.0.0.1:<port>/mcp` and captures the Quick Tunnel URL.

The adapter writes generated config, token state, and logs under `.secure-mcp/`. That directory is ignored by git and blocked by the runtime's secret-like path policy.
