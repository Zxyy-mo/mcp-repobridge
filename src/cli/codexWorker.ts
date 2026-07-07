#!/usr/bin/env node
import { loadConfig } from "../config/config.js";
import { processNextCodexTask } from "../codexHandoff/worker.js";

type CliOptions = {
  config?: string;
  once: boolean;
  workerId?: string;
  pollIntervalMs?: number;
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options.config) {
    printUsage();
    process.exit(1);
  }

  const config = await loadConfig(options.config);
  const pollIntervalMs = options.pollIntervalMs ?? config.codexHandoff.workerPollIntervalMs;

  while (true) {
    const result = await processNextCodexTask(config, { workerId: options.workerId });
    process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), ...result })}\n`);
    if (options.once) return;
    if (!result.processed) {
      await sleep(pollIntervalMs);
    }
  }
}

function parseArgs(args: string[]): CliOptions {
  if (args[0] === "--") {
    args = args.slice(1);
  }
  const options: CliOptions = { once: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--once") {
      options.once = true;
      continue;
    }
    const { key, value, consumedNext } = readOption(arg, args[index + 1]);
    if (consumedNext) index += 1;
    switch (key) {
      case "config":
        options.config = value;
        break;
      case "workerId":
        options.workerId = value;
        break;
      case "pollIntervalMs":
        options.pollIntervalMs = Number(value);
        break;
      default:
        throw new Error(`Unknown option: --${key}`);
    }
  }
  return options;
}

function readOption(arg: string, next: string | undefined): { key: string; value: string; consumedNext: boolean } {
  if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
  const equalsIndex = arg.indexOf("=");
  if (equalsIndex >= 0) {
    return {
      key: toCamel(arg.slice(2, equalsIndex)),
      value: arg.slice(equalsIndex + 1),
      consumedNext: false
    };
  }
  if (!next || next.startsWith("--")) throw new Error(`Missing value for ${arg}`);
  return {
    key: toCamel(arg.slice(2)),
    value: next,
    consumedNext: true
  };
}

function toCamel(value: string): string {
  return value.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase());
}

function printUsage(): void {
  process.stdout.write(`Usage:
  node dist/cli/codexWorker.js --config <runtime.config.json> [--once] [--poll-interval-ms 5000]

The worker claims queued codex_task_create jobs and runs the configured Codex command locally.
`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
