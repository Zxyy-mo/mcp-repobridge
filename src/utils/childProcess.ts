import { spawn } from "node:child_process";

export type SpawnResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
};

export async function spawnLimited(
  command: string,
  args: string[],
  options: {
    timeoutMs: number;
    maxOutputBytes: number;
    env?: NodeJS.ProcessEnv;
  }
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      env: options.env ?? process.env
    });

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let truncated = false;
    let timeoutFired = false;
    let killedForOutputLimit = false;
    let settled = false;

    const timer = setTimeout(() => {
      timeoutFired = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);

    const append = (current: Buffer, chunk: Buffer) => {
      const next = Buffer.concat([current, chunk]);
      if (next.length > options.maxOutputBytes) {
        truncated = true;
        if (!killedForOutputLimit) {
          killedForOutputLimit = true;
          child.kill("SIGKILL");
        }
        return next.subarray(0, options.maxOutputBytes);
      }
      return next;
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    child.on("close", (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          code,
          signal,
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
          timedOut: timeoutFired,
          truncated
        });
      }
    });
  });
}
