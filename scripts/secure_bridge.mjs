#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const DEFAULT_PORT = 8765;
const DEFAULT_TOKEN_ENV = "SECURE_MCP_TOKEN";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

async function main() {
  const { action, options } = parseArgs(process.argv.slice(2));
  switch (action) {
    case "start":
      await start(options);
      break;
    case "stop":
      await stop(options);
      break;
    case "status":
      await status(options);
      break;
    case "rotate":
      await rotate(options);
      break;
    default:
      printUsage();
      process.exit(action ? 1 : 0);
  }
}

async function start(options) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const stateDir = path.resolve(options.stateDir ?? path.join(projectRoot, ".secure-mcp"));
  const statePath = path.join(stateDir, "bridge-state.json");
  const existing = await readJsonIfExists(statePath);
  if (existing?.runtime?.pid && isProcessRunning(existing.runtime.pid)) {
    throw new Error(`secure-mcp-runtime already running with pid ${existing.runtime.pid}`);
  }

  const port = Number(options.port ?? DEFAULT_PORT);
  const tokenEnv = options.tokenEnv ?? DEFAULT_TOKEN_ENV;
  const token = options.token ?? randomBytes(32).toString("base64url");
  const tunnelMode = options.tunnel ?? "none";
  if (tunnelMode === "cloudflare" && !commandExists("cloudflared")) {
    throw new Error("cloudflared not found in PATH. Install it or use --tunnel external.");
  }
  const runtimeEntry = path.resolve(options.runtime ?? path.join(REPO_ROOT, "dist", "index.js"));
  if (!fsSync.existsSync(runtimeEntry)) {
    throw new Error(`Runtime entry not found: ${runtimeEntry}. Run npm run build first.`);
  }

  await fs.mkdir(stateDir, { recursive: true });
  const configPath = path.resolve(options.config ?? path.join(stateDir, "runtime.config.json"));
  const config = runtimeConfig(projectRoot, port, tokenEnv, options);
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });

  const outPath = path.join(stateDir, "runtime.out.log");
  const errPath = path.join(stateDir, "runtime.err.log");
  const runtime = spawn(process.execPath, [runtimeEntry, `--config=${configPath}`], {
    cwd: projectRoot,
    env: { ...process.env, [tokenEnv]: token },
    detached: true,
    stdio: ["ignore", fsSync.openSync(outPath, "a"), fsSync.openSync(errPath, "a")]
  });
  let tunnel;
  try {
    runtime.unref();
    await sleep(750);
    if (!isProcessRunning(runtime.pid)) {
      throw new Error(`secure-mcp-runtime exited during startup. See ${errPath}`);
    }

    const localMcpUrl = `http://127.0.0.1:${port}/mcp`;
    tunnel = await startTunnel(options, localMcpUrl, stateDir);
  } catch (error) {
    if (runtime.pid && isProcessRunning(runtime.pid)) {
      stopProcess(runtime.pid);
      await waitForExit(runtime.pid, 3000);
    }
    throw error;
  }
  const localMcpUrl = `http://127.0.0.1:${port}/mcp`;
  const publicMcpUrl = tunnel.publicBaseUrl ? `${tunnel.publicBaseUrl.replace(/\/+$/, "")}/mcp` : localMcpUrl;
  const state = {
    startedAt: new Date().toISOString(),
    projectRoot,
    configPath,
    tokenEnv,
    token,
    localMcpUrl,
    publicMcpUrl,
    codexHandoffEnabled: config.codexHandoff.enabled,
    codexWorkerCommand: config.codexHandoff.enabled
      ? `npm run --silent codex-worker -- --config ${configPath}`
      : undefined,
    runtime: {
      pid: runtime.pid,
      stdout: outPath,
      stderr: errPath
    },
    tunnel
  };
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  writeJson(state);
}

async function stop(options) {
  const state = await requireState(options);
  const stopped = [];
  if (state.tunnel?.pid) {
    const signaled = stopProcess(state.tunnel.pid);
    stopped.push({ kind: "tunnel", pid: state.tunnel.pid, stopped: signaled, exited: signaled ? await waitForExit(state.tunnel.pid, 3000) : true });
  }
  if (state.runtime?.pid) {
    const signaled = stopProcess(state.runtime.pid);
    stopped.push({ kind: "runtime", pid: state.runtime.pid, stopped: signaled, exited: signaled ? await waitForExit(state.runtime.pid, 3000) : true });
  }
  state.stoppedAt = new Date().toISOString();
  state.stopped = stopped;
  await fs.writeFile(state.__statePath, JSON.stringify(stripInternal(state), null, 2), { mode: 0o600 });
  writeJson({ stopped });
}

async function status(options) {
  const state = await readState(options);
  if (!state) {
    writeJson({ running: false });
    return;
  }
  writeJson({
    running: Boolean(state.runtime?.pid && isProcessRunning(state.runtime.pid)),
    runtimePid: state.runtime?.pid,
    tunnelRunning: Boolean(state.tunnel?.pid && isProcessRunning(state.tunnel.pid)),
    tunnelPid: state.tunnel?.pid,
    localMcpUrl: state.localMcpUrl,
    publicMcpUrl: state.publicMcpUrl,
    codexHandoffEnabled: state.codexHandoffEnabled,
    codexWorkerCommand: state.codexWorkerCommand,
    projectRoot: state.projectRoot,
    startedAt: state.startedAt,
    stoppedAt: state.stoppedAt
  });
}

async function rotate(options) {
  const state = await readState(options);
  if (state?.runtime?.pid && isProcessRunning(state.runtime.pid)) {
    await stop(options);
  }
  await start({
    ...options,
    token: randomBytes(32).toString("base64url"),
    projectRoot: options.projectRoot ?? state?.projectRoot,
    port: options.port ?? portFromUrl(state?.localMcpUrl)
  });
}

async function startTunnel(options, localMcpUrl, stateDir) {
  const tunnelMode = options.tunnel ?? "none";
  if (tunnelMode === "none" || tunnelMode === "local") {
    return { mode: tunnelMode };
  }
  if (tunnelMode === "external") {
    if (!options.publicBaseUrl) {
      throw new Error("--public-base-url is required with --tunnel external");
    }
    return { mode: "external", publicBaseUrl: options.publicBaseUrl };
  }
  if (tunnelMode !== "cloudflare") {
    throw new Error(`Unsupported tunnel mode: ${tunnelMode}`);
  }
  if (!commandExists("cloudflared")) {
    throw new Error("cloudflared not found in PATH. Install it or use --tunnel external.");
  }

  const outPath = path.join(stateDir, "cloudflared.out.log");
  const errPath = path.join(stateDir, "cloudflared.err.log");
  const child = spawn("cloudflared", ["tunnel", "--url", localMcpUrl], {
    detached: true,
    stdio: ["ignore", fsSync.openSync(outPath, "a"), fsSync.openSync(errPath, "a")]
  });
  child.unref();

  const publicBaseUrl = await waitForCloudflareUrl([outPath, errPath], 30000);
  return {
    mode: "cloudflare",
    pid: child.pid,
    publicBaseUrl,
    stdout: outPath,
    stderr: errPath
  };
}

async function waitForCloudflareUrl(logPaths, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const pattern = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
  while (Date.now() < deadline) {
    for (const logPath of logPaths) {
      const text = await readTextIfExists(logPath);
      const match = text.match(pattern);
      if (match) return match[0];
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for cloudflared URL. See ${logPaths.join(" and ")}`);
}

function runtimeConfig(projectRoot, port, tokenEnv, options) {
  return {
    server: {
      host: options.host ?? "127.0.0.1",
      port,
      transport: "streamable-http",
      authTokenEnv: tokenEnv,
      allowedOrigins: splitList(options.allowedOrigins) ?? ["https://chatgpt.com", "https://chat.openai.com"]
    },
    workspace: {
      root: projectRoot,
      containerPath: options.containerPath ?? "/workspace",
      defaultMountMode: options.mountMode ?? "ro",
      maxReadBytes: Number(options.maxReadBytes ?? 1048576),
      maxDirectoryEntries: Number(options.maxDirectoryEntries ?? 1000)
    },
    sandbox: {
      containerName: options.containerName ?? "secure-mcp-sandbox",
      image: options.image ?? "secure-mcp-sandbox:latest",
      network: options.network ?? "none",
      memory: options.memory ?? "2g",
      cpus: options.cpus ?? "2",
      pidsLimit: Number(options.pidsLimit ?? 256),
      user: options.user ?? "1000:1000",
      readOnlyRootfs: options.readOnlyRootfs !== "false",
      tmpfs: splitList(options.tmpfs) ?? ["/tmp:rw,nosuid,nodev,size=512m"],
      timeoutMs: Number(options.timeoutMs ?? 30000),
      maxOutputBytes: Number(options.maxOutputBytes ?? 200000)
    },
    policy: {
      allowExec: options.allowExec !== "false",
      execMode: options.execMode ?? "denylist",
      allowedCommands: splitList(options.allowedCommands),
      denyNetworkCommands: options.denyNetworkCommands !== "false",
      denyDockerInsideContainer: options.denyDockerInsideContainer !== "false",
      denySecretsRead: options.denySecretsRead !== "false"
    },
    audit: {
      enabled: options.auditEnabled !== "false",
      path: options.auditPath ?? ".secure-mcp/audit.log"
    },
    codexHandoff: {
      enabled: options.codexHandoff === "true" || options.enableCodexHandoff === "true",
      queuePath: options.codexQueuePath ?? ".secure-mcp/codex-tasks",
      maxPromptBytes: Number(options.codexMaxPromptBytes ?? 24000),
      maxResultBytes: Number(options.codexMaxResultBytes ?? 200000),
      maxTasksListed: Number(options.codexMaxTasksListed ?? 50),
      taskTimeoutMs: Number(options.codexTaskTimeoutMs ?? 1800000),
      workerPollIntervalMs: Number(options.codexWorkerPollIntervalMs ?? 5000),
      codexCommand: options.codexCommand ?? "codex",
      codexArgs: splitList(options.codexArgs) ?? [
        "exec",
        "--sandbox",
        "workspace-write",
        "--ask-for-approval",
        "never",
        "--json",
        "-"
      ]
    }
  };
}

async function requireState(options) {
  const state = await readState(options);
  if (!state) throw new Error("No bridge state found.");
  return state;
}

async function readState(options) {
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  const stateDir = path.resolve(options.stateDir ?? path.join(projectRoot, ".secure-mcp"));
  const statePath = path.join(stateDir, "bridge-state.json");
  const state = await readJsonIfExists(statePath);
  if (!state) return undefined;
  return { ...state, __statePath: statePath };
}

function parseArgs(args) {
  if (args[0] === "--") {
    args = args.slice(1);
  }
  const action = args[0];
  const options = {};
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const equalsIndex = arg.indexOf("=");
    if (equalsIndex >= 0) {
      options[toCamel(arg.slice(2, equalsIndex))] = arg.slice(equalsIndex + 1);
      continue;
    }
    const key = toCamel(arg.slice(2));
    const next = args[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = "true";
      continue;
    }
    options[key] = next;
    index += 1;
  }
  return { action, options };
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function splitList(value) {
  if (!value) return undefined;
  if (Array.isArray(value)) return value;
  return String(value).split(",").map((entry) => entry.trim()).filter(Boolean);
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

function isProcessRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function stopProcess(pid) {
  if (!pid || !isProcessRunning(pid)) return false;
  try {
    if (process.platform === "win32") {
      process.kill(pid, "SIGTERM");
    } else {
      process.kill(-pid, "SIGTERM");
    }
    return true;
  } catch {
    try {
      process.kill(pid, "SIGTERM");
      return true;
    } catch {
      return false;
    }
  }
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) return true;
    await sleep(100);
  }
  return !isProcessRunning(pid);
}

function commandExists(command) {
  const pathValue = process.env.PATH ?? "";
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const directory of pathValue.split(path.delimiter)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      if (fsSync.existsSync(candidate)) return true;
    }
  }
  return false;
}

function portFromUrl(url) {
  if (!url) return DEFAULT_PORT;
  return new URL(url).port || DEFAULT_PORT;
}

function stripInternal(state) {
  const { __statePath, ...publicState } = state;
  return publicState;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(stripInternal(value), null, 2)}\n`);
}

function printUsage() {
  process.stdout.write(`Usage:
  node scripts/secure_bridge.mjs start --project-root <path> [--port 8765] [--tunnel none|external|cloudflare]
  node scripts/secure_bridge.mjs status --project-root <path>
  node scripts/secure_bridge.mjs stop --project-root <path>
  node scripts/secure_bridge.mjs rotate --project-root <path>

Tunnel options:
  --tunnel external --public-base-url https://your-host.example.com
  --tunnel cloudflare

Codex handoff:
  --codex-handoff true
  npm run --silent codex-worker -- --config <project>/.secure-mcp/runtime.config.json
`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
