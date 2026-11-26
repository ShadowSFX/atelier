/** stdin/stdout helpers for the scripts Claude Code runs (hook, statusLine). */

/** All of stdin, or what arrived before the timeout. */
export function readStdin(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c: string) => (data += c));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on('error', () => resolve(data));
  });
}

/** Writes to stdout and waits until it is flushed (pipe writes can still be pending when the process exits). */
export function print(text: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      process.stdout.write(text, () => resolve());
    } catch {
      resolve();
    }
  });
}
