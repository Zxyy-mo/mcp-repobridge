# Linux Server Tunnel Trial

## Goal

Run MCP RepoBridge on a separate Linux server instead of exposing a tunnel
from a personal workstation or WSL environment.

This keeps the public tunnel, Docker sandbox, and MCP runtime on a disposable
server-side workspace. The local computer does not need to run `cloudflared` or
accept inbound traffic.

## Recommended topology

```text
ChatGPT MCP client
        |
        | HTTPS + bearer token
        v
Cloudflare Tunnel or another reverse tunnel
        |
        | forwards to 127.0.0.1:<port>/mcp on the Linux server
        v
MCP RepoBridge on Linux
        |
        | read-only file tools limited to server workspace
        | docker exec into fixed sandbox container
        v
Docker sandbox container
```

The tunnel endpoint is public. Treat the generated URL and bearer token as
sensitive credentials.

## Server requirements

Use a server you are comfortable treating as an experiment host.

Minimum practical requirements:

- Linux VM or VPS with outbound HTTPS access.
- Docker Engine available to the runtime user.
- Node.js 22 or newer.
- npm.
- Git.
- Optional: `cloudflared` when using Cloudflare Quick Tunnel.

Keep the server workspace separate from personal files. Do not mount host HOME,
SSH keys, cloud credentials, browser profiles, or Docker socket into the sandbox.

## Prepare the runtime

On the Linux server:

```bash
git clone <your-mcp-repobridge-repo-url>
cd mcp-repobridge
npm install
npm test
npm run build
docker build -f docker/Dockerfile.sandbox -t secure-mcp-sandbox:latest docker
```

Prepare the project workspace that ChatGPT should inspect:

```bash
mkdir -p ~/mcp-workspaces
git clone <project-repo-url> ~/mcp-workspaces/project
```

Use a clean branch or disposable clone for early tests.

## Option A: Cloudflare Quick Tunnel

Install `cloudflared` using Cloudflare's official Linux package instructions.
Confirm it is on PATH:

```bash
cloudflared --version
```

Start the bridge:

```bash
npm run --silent bridge -- start \
  --project-root "$HOME/mcp-workspaces/project" \
  --tunnel cloudflare
```

The command prints JSON containing:

- `publicMcpUrl`: the URL to configure in ChatGPT.
- `token`: the bearer token to configure in ChatGPT.
- `localMcpUrl`: the local server URL, normally `http://127.0.0.1:8765/mcp`.
- `runtime.pid`: runtime process id.
- `tunnel.pid`: cloudflared process id.

Check status:

```bash
npm run --silent bridge -- status --project-root "$HOME/mcp-workspaces/project"
```

Stop both runtime and tunnel:

```bash
npm run --silent bridge -- stop --project-root "$HOME/mcp-workspaces/project"
```

Rotate the bearer token:

```bash
npm run --silent bridge -- rotate --project-root "$HOME/mcp-workspaces/project"
```

After rotation, update ChatGPT with the new token.

## Option B: Managed Tunnel or Reverse Proxy

If you manage the tunnel outside this runtime, point it at:

```text
http://127.0.0.1:8765/mcp
```

Then start the runtime and record your external base URL:

```bash
npm run --silent bridge -- start \
  --project-root "$HOME/mcp-workspaces/project" \
  --tunnel external \
  --public-base-url https://your-public-host.example.com
```

The bridge reports:

```text
https://your-public-host.example.com/mcp
```

Use that URL in ChatGPT.

Do not expose the local MCP HTTP server without bearer-token enforcement. Keep
the runtime bound to `127.0.0.1` unless you have a specific network design that
requires otherwise.

## ChatGPT configuration values

Use the values printed by `bridge start`:

```text
MCP URL: publicMcpUrl
Authorization: Bearer <token>
```

If ChatGPT asks for only a token field, provide the raw `token` value. If it asks
for headers, use:

```text
Authorization: Bearer <token>
```

## Docker sandbox validation

Before exposing the URL to ChatGPT, verify the sandbox:

```bash
npm run --silent bridge -- status --project-root "$HOME/mcp-workspaces/project"
```

Then call these tools through your MCP client or a local test client:

```text
sandbox_start
sandbox_status
exec_container: pwd
exec_container: whoami
exec_container: rg --version
exec_container: curl https://example.com
exec_container: docker ps
exec_container: sleep 999
exec_container: yes
sandbox_stop
```

Expected results:

- `pwd` returns `/workspace`.
- `whoami` is non-root when configured with `1000:1000`.
- `curl` is rejected by policy or cannot access the network.
- `docker ps` is rejected by policy or unavailable.
- `sleep 999` times out.
- `yes` output is capped.

## Optional Codex handoff on the server

If you want ChatGPT to queue implementation work for Codex on the Linux server,
start the bridge with handoff enabled:

```bash
npm run --silent bridge -- start \
  --project-root "$HOME/mcp-workspaces/project" \
  --tunnel cloudflare \
  --codex-handoff true
```

Then run the worker in another server terminal:

```bash
npm run --silent codex-worker -- \
  --config "$HOME/mcp-workspaces/project/.secure-mcp/runtime.config.json"
```

Only enable this if the server has Codex installed and authenticated, and if you
are comfortable letting the worker modify the server-side workspace.

## Security checklist

Before testing from ChatGPT:

- Use a disposable server or isolated VM.
- Use a clean project clone.
- Build and use the fixed sandbox image from trusted source.
- Keep `server.host` bound to `127.0.0.1`.
- Use a strong random bearer token.
- Do not commit `.secure-mcp/`.
- Do not mount host HOME, SSH keys, cloud credentials, browser profiles, or
  Docker socket into the sandbox.
- Keep sandbox network as `none` unless you have a reviewed reason to change it.
- Keep workspace mount `ro` for review-style use.
- Stop the tunnel when testing is done.
- Rotate the token if the URL or token was shared in the wrong place.

## Operational notes

Cloudflare Quick Tunnel URLs are usually temporary. Restarting the tunnel can
produce a new URL, so ChatGPT may need to be updated after restart.

For a stable URL, use a named Cloudflare Tunnel or another managed reverse proxy,
then run the bridge with `--tunnel external --public-base-url <base-url>`.

Logs and generated config are stored under:

```text
<project-root>/.secure-mcp/
```

Important files:

```text
bridge-state.json
runtime.config.json
runtime.out.log
runtime.err.log
cloudflared.out.log
cloudflared.err.log
audit.log
```

## Cleanup

Stop runtime and tunnel:

```bash
npm run --silent bridge -- stop --project-root "$HOME/mcp-workspaces/project"
```

Remove the sandbox container if needed:

```bash
docker rm -f secure-mcp-sandbox
```

Remove the test workspace when finished:

```bash
rm -rf "$HOME/mcp-workspaces/project"
```
