import { loadConfig } from "./config/config.js";
import { createMcpServer } from "./server/mcpServer.js";

async function main() {
  const configPath = parseConfigPath(process.argv.slice(2));
  const config = await loadConfig(configPath);
  const running = await createMcpServer(config);
  if (running) {
    console.error(`mcp-repobridge listening on ${running.url}`);
  }
}

function parseConfigPath(args: string[]): string {
  const equalsArg = args.find((arg) => arg.startsWith("--config="));
  if (equalsArg) return equalsArg.slice("--config=".length);
  const flagIndex = args.indexOf("--config");
  if (flagIndex >= 0 && args[flagIndex + 1]) return args[flagIndex + 1];
  return "examples/config.example.json";
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
