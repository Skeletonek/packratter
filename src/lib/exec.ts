import { spawn } from 'node:child_process';
import { config } from '../config.js';

export class CommandError extends Error {
  constructor(
    message: string,
    readonly code: 'COMMAND_FAILED' | 'COMMAND_TIMEOUT' = 'COMMAND_FAILED',
  ) {
    super(message);
  }
}

interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

// Spawns a command, streaming stdout/stderr lines to `log` as they arrive and
// capturing the output. Rejects with a CommandError on a non-zero exit code,
// spawn failure, or timeout.
export function run(
  cmd: string,
  args: string[],
  opts: RunOptions,
  log: (line: string) => void = () => {},
): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs = opts.timeoutMs ?? config.COMMAND_TIMEOUT_S * 1000;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, opts);
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
      reject(
        new CommandError(`\`${cmd}\` timed out after ${timeoutMs / 1000}s`, 'COMMAND_TIMEOUT'),
      );
    }, timeoutMs);
    timer.unref();

    const attach = (stream: NodeJS.ReadableStream, capture: (text: string) => void) => {
      let buffer = '';
      stream.setEncoding('utf8');
      stream.on('data', (text: string) => {
        capture(text);
        buffer += text;
        let nl = buffer.indexOf('\n');
        while (nl >= 0) {
          log(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf('\n');
        }
      });
      stream.on('end', () => {
        if (buffer) log(buffer);
      });
    };

    attach(child.stdout, (text) => (stdout += text));
    attach(child.stderr, (text) => (stderr += text));

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new CommandError(`\`${cmd}\` could not be started: ${err.message}`));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        const detail = stderr.trim().split('\n').slice(-3).join(' | ');
        reject(
          new CommandError(`\`${cmd}\` failed with code ${code}${detail ? `: ${detail}` : ''}`),
        );
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}
