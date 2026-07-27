import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { StringDecoder } from 'string_decoder';

export interface ProcessRunOptions {
  id?: string;
  command: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ProcessRunResult {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export class ProcessRunner {
  private active = new Map<string, ChildProcessWithoutNullStreams>();

  async run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    const id = options.id ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const args = options.args ?? [];
    const startedAt = Date.now();
    let timedOut = false;

    return new Promise<ProcessRunResult>((resolve, reject) => {
      const child = spawn(options.command, args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        stdio: 'pipe',
      });
      let stdout = '';
      let stderr = '';
      const stdoutDecoder = new StringDecoder('utf8');
      const stderrDecoder = new StringDecoder('utf8');
      let settled = false;

      this.active.set(id, child);

      const timeout = options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
        }, options.timeoutMs)
        : undefined;

      const abort = () => {
        child.kill('SIGTERM');
      };

      if (options.signal) {
        if (options.signal.aborted) {
          abort();
        } else {
          options.signal.addEventListener('abort', abort, { once: true });
        }
      }

      child.stdout.on('data', chunk => {
        stdout += stdoutDecoder.write(chunk);
      });
      child.stderr.on('data', chunk => {
        stderr += stderrDecoder.write(chunk);
      });

      child.on('error', error => {
        if (settled) return;
        settled = true;
        this.active.delete(id);
        if (timeout) clearTimeout(timeout);
        if (options.signal) options.signal.removeEventListener('abort', abort);
        reject(error);
      });

      child.on('close', (exitCode, signal) => {
        if (settled) return;
        settled = true;
        this.active.delete(id);
        if (timeout) clearTimeout(timeout);
        if (options.signal) options.signal.removeEventListener('abort', abort);
        stdout += stdoutDecoder.end();
        stderr += stderrDecoder.end();
        resolve({
          id,
          command: options.command,
          args,
          cwd: options.cwd,
          exitCode,
          signal,
          stdout,
          stderr,
          durationMs: Date.now() - startedAt,
          timedOut,
        });
      });

      if (options.input) {
        child.stdin.write(options.input);
      }
      child.stdin.end();
    });
  }

  async cancel(id: string): Promise<void> {
    const child = this.active.get(id);
    if (!child) return;
    child.kill('SIGTERM');
  }
}
