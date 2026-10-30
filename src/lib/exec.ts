import { spawn } from 'node:child_process';

interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

// Spawns a command, streaming stdout/stderr lines to `log` as they arrive and
// capturing the output. Rejects on a non-zero exit code or spawn failure.
export function run(
  cmd: string,
  args: string[],
  opts: RunOptions,
  log: (line: string) => void = () => {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, opts);
    let stdout = '';
    let stderr = '';

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

    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`\`${cmd}\` failed with code ${code}`));
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}
