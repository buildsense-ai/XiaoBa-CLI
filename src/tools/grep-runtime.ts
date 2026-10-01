/**
 * GrepTool runtime helpers: one absolute deadline shared by every local search
 * backend, typed terminal outcomes, bounded child-process execution, a worker
 * isolate for adversarial regex matching, and glob/type-filter resolution.
 *
 * Budget constants live in grep-search-policy.ts (shared with the RPC layer);
 * this module only consumes them.
 */

import { spawn } from 'child_process';
import { Worker } from 'worker_threads';
import {
  GREP_DEFAULT_TIMEOUT_MS,
  GREP_MAX_TIMEOUT_MS,
  GREP_MIN_TIMEOUT_MS,
} from './grep-search-policy';

export {
  GREP_DEFAULT_TIMEOUT_MS,
  GREP_MAX_TIMEOUT_MS,
  GREP_MIN_TIMEOUT_MS,
  GREP_RPC_GRACE_MS,
  resolveGrepRpcTimeoutMs,
  resolveGrepSearchTimeoutMs,
} from './grep-search-policy';

/** Hard cap on stdout a backend may produce before the scan is declared incomplete. */
export const GREP_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
/** Stderr is diagnostic only; stop collecting past this instead of buffering forever. */
export const GREP_MAX_STDERR_BYTES = 1024 * 1024;
/** SIGTERM → SIGKILL escalation window for backend children. */
export const GREP_KILL_GRACE_MS = 1_500;

export type GrepBackendName = 'ripgrep' | 'grep' | 'node';
export type GrepBackendOutcome =
  | 'ok'
  | 'no_match'
  | 'error'
  | 'timeout'
  | 'cancelled'
  | 'overflow'
  | 'invalid_pattern'
  | 'unsupported_type';

export class GrepSearchError extends Error {
  readonly errorCode: string;

  constructor(errorCode: string, message: string) {
    super(message);
    this.name = 'GrepSearchError';
    this.errorCode = errorCode;
  }
}

/** The absolute deadline expired. Terminal: no backend may start or continue. */
export class GrepTimeoutError extends GrepSearchError {
  constructor(budgetMs: number) {
    super('SEARCH_TIMEOUT', `搜索超时：本地搜索未能在 ${budgetMs}ms 内完成，结果不完整，已停止全部后端。可在 100..30000 范围内调大 timeout_ms 后重试。`);
    this.name = 'GrepTimeoutError';
  }
}

/** The caller's abort signal fired. Terminal, and distinct from a deadline hit. */
export class GrepCancelledError extends GrepSearchError {
  constructor() {
    super('SEARCH_CANCELLED', '搜索已取消');
    this.name = 'GrepCancelledError';
  }
}

/** A backend produced more output than the bound. Terminal: results would be incomplete. */
export class GrepOverflowError extends GrepSearchError {
  constructor(maxOutputBytes: number) {
    super('SEARCH_RESULT_OVERFLOW', `搜索结果超过 ${maxOutputBytes} 字节上限，为避免返回不完整结果已终止搜索。请用 glob/type/limit 缩小范围。`);
    this.name = 'GrepOverflowError';
  }
}

/** The pattern is not a valid regular expression. Visible failure, never an empty result. */
export class GrepInvalidPatternError extends GrepSearchError {
  constructor(detail: string) {
    super('INVALID_PATTERN', `搜索模式不是有效的正则表达式: ${detail}`);
    this.name = 'GrepInvalidPatternError';
  }
}

/** The requested ripgrep-style type filter cannot be applied by this backend. */
export class GrepUnsupportedTypeError extends GrepSearchError {
  constructor(fileType: string, backend: GrepBackendName) {
    super('UNSUPPORTED_FILE_TYPE', `后端 ${backend} 不支持文件类型过滤 "${fileType}"，搜索不会在忽略该过滤的情况下执行。`);
    this.name = 'GrepUnsupportedTypeError';
  }
}

/** A genuine backend failure (spawn failure, non-0/1 exit, IO error). Fallback may continue. */
export class GrepBackendError extends GrepSearchError {
  constructor(message: string) {
    super('SEARCH_BACKEND_ERROR', message);
    this.name = 'GrepBackendError';
  }
}

type DeadlineReason = 'timeout' | 'cancelled';

/**
 * ONE absolute deadline shared by all local backends for a single search.
 * Combines the caller's abort signal with a wall-clock budget into one internal
 * signal, so children, file reads and the matcher worker are all interrupted by
 * whichever arrives first — and the reason stays typed.
 */
export class GrepDeadline {
  readonly budgetMs: number;
  private readonly controller = new AbortController();
  private readonly startedAt = Date.now();
  private timer: NodeJS.Timeout | undefined;
  private callerSignal?: AbortSignal;
  private callerHandler?: () => void;
  private fired?: DeadlineReason;

  constructor(budgetMs: number, callerSignal?: AbortSignal) {
    this.budgetMs = budgetMs;
    // Kept referenced on purpose: if the event loop is otherwise idle the timer
    // must still fire so the in-flight search settles instead of hanging.
    this.timer = setTimeout(() => this.fire('timeout'), budgetMs);
    if (callerSignal?.aborted) {
      this.fire('cancelled');
      return;
    }
    if (callerSignal) {
      this.callerSignal = callerSignal;
      this.callerHandler = () => this.fire('cancelled');
      callerSignal.addEventListener('abort', this.callerHandler, { once: true });
    }
  }

  private fire(reason: DeadlineReason): void {
    if (this.fired) return;
    this.fired = reason;
    this.controller.abort(reason);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get expired(): boolean {
    return this.fired !== undefined;
  }

  get reasonType(): DeadlineReason {
    return this.fired ?? 'timeout';
  }

  remainingMs(): number {
    return Math.max(0, this.budgetMs - (Date.now() - this.startedAt));
  }

  /** Throws the typed terminal error when the deadline or cancellation already fired. */
  check(): void {
    if (!this.fired) return;
    throw this.fired === 'timeout'
      ? new GrepTimeoutError(this.budgetMs)
      : new GrepCancelledError();
  }

  rethrowIfExpired(): void {
    this.check();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.callerSignal && this.callerHandler) {
      this.callerSignal.removeEventListener('abort', this.callerHandler);
    }
    this.callerHandler = undefined;
    this.callerSignal = undefined;
  }
}

export interface GrepCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface GrepCommandOptions {
  cwd: string;
  deadline: GrepDeadline;
  maxOutputBytes?: number;
}

/**
 * Run one backend command under the shared deadline. Kills the child on
 * timeout/cancel (SIGTERM, then SIGKILL), throws typed terminal errors for
 * deadline/cancel/overflow, and a fallback-able GrepBackendError otherwise.
 * Exit code 1 is a clean "no matches" and resolves normally.
 */
export function spawnGrepCommand(
  command: string,
  args: string[],
  options: GrepCommandOptions,
): Promise<GrepCommandResult> {
  const { deadline } = options;
  const maxOutputBytes = options.maxOutputBytes ?? GREP_MAX_OUTPUT_BYTES;

  return new Promise<GrepCommandResult>((resolve, reject) => {
    let settled = false;
    let overflowed = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let killEscalation: NodeJS.Timeout | undefined;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    let child;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        signal: deadline.signal,
        windowsHide: true,
      });
    } catch (error: any) {
      reject(new GrepBackendError(`无法启动 ${command}: ${error?.message || error}`));
      return;
    }

    const killTree = (signal: NodeJS.Signals): void => {
      try {
        child.kill(signal);
      } catch {
        // already gone
      }
    };

    const onAbort = (): void => {
      killTree('SIGTERM');
      killEscalation = setTimeout(() => killTree('SIGKILL'), GREP_KILL_GRACE_MS);
      killEscalation.unref?.();
    };
    if (deadline.expired) onAbort();
    else deadline.signal.addEventListener('abort', onAbort, { once: true });

    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      if (killEscalation) clearTimeout(killEscalation);
      deadline.signal.removeEventListener('abort', onAbort);
      finish();
    };

    const fail = (error: GrepSearchError): void => {
      settle(() => {
        killTree('SIGKILL');
        reject(error);
      });
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      if (overflowed) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        overflowed = true;
        fail(new GrepOverflowError(maxOutputBytes));
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes > GREP_MAX_STDERR_BYTES) return;
      stderrBytes += chunk.length;
      stderrChunks.push(chunk);
    });

    child.on('error', (error: any) => {
      // 当 deadline/abort 触发时，spawn 的 signal 机制会先发 AbortError：
      // 这必须映射为类型化终态，而不是可回退的后端错误。
      if (deadline.expired) {
        fail(deadline.reasonType === 'timeout'
          ? new GrepTimeoutError(deadline.budgetMs)
          : new GrepCancelledError());
        return;
      }
      fail(new GrepBackendError(`无法启动 ${command}: ${error?.message || error}`));
    });

    child.on('close', (code: number | null) => {
      if (overflowed) return; // already settled by fail()
      const stdoutText = Buffer.concat(stdoutChunks).toString('utf8');
      const stderrText = Buffer.concat(stderrChunks).toString('utf8');
      settle(() => {
        if (deadline.expired) {
          reject(deadline.reasonType === 'timeout'
            ? new GrepTimeoutError(deadline.budgetMs)
            : new GrepCancelledError());
          return;
        }
        if (code === 0 || code === 1) {
          resolve({ exitCode: code as number, stdout: stdoutText, stderr: stderrText });
          return;
        }
        reject(new GrepBackendError(stderrText.trim() || `${command} 执行失败 (exit ${code})`));
      });
    });
  });
}

export interface GrepGlobMatcher {
  source: string;
  regexp: RegExp;
  /** Globs containing '/' match the path relative to the search root; others match basenames. */
  matchAgainstPath: boolean;
}

function escapeRegexChar(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

function parseGlobSequence(glob: string, cursor: { i: number }, topLevel: boolean): string {
  let out = '';
  while (cursor.i < glob.length) {
    const ch = glob[cursor.i];
    if (!topLevel && (ch === ',' || ch === '}')) return out;
    cursor.i += 1;
    if (ch === '*') {
      if (glob[cursor.i] === '*') {
        while (glob[cursor.i] === '*') cursor.i += 1;
        out += '.*';
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if (ch === '{') {
      const alternatives: string[] = [];
      for (;;) {
        alternatives.push(parseGlobSequence(glob, cursor, false));
        if (glob[cursor.i] === ',') {
          cursor.i += 1;
          continue;
        }
        if (glob[cursor.i] === '}') cursor.i += 1; // unbalanced braces degrade to literal end
        break;
      }
      out += `(?:${alternatives.join('|')})`;
    } else {
      out += escapeRegexChar(ch);
    }
  }
  return out;
}

/** Convert a user glob ("*.js", "*.{ts,tsx}") into an anchored RegExp. A '/' in the glob switches matching to the root-relative path. */
export function globToRegExp(glob: string): GrepGlobMatcher {
  const source = `^${parseGlobSequence(glob, { i: 0 }, true)}$`;
  return {
    source: glob,
    regexp: new RegExp(source),
    matchAgainstPath: glob.includes('/'),
  };
}

export function matchGlob(
  matcher: GrepGlobMatcher,
  relativePath: string,
  basename: string,
): boolean {
  return matcher.matchAgainstPath
    ? matcher.regexp.test(relativePath)
    : matcher.regexp.test(basename);
}

/**
 * Common ripgrep type names → basename globs. Types outside this map are
 * visibly unsupported for grep/node backends instead of silently widening scope.
 */
const TYPE_FILTER_GLOBS: Record<string, string[]> = {
  js: ['*.js', '*.jsx', '*.mjs', '*.cjs'],
  jsx: ['*.jsx'],
  ts: ['*.ts', '*.tsx', '*.mts', '*.cts'],
  tsx: ['*.tsx'],
  typescript: ['*.ts', '*.tsx'],
  python: ['*.py', '*.pyi'],
  py: ['*.py', '*.pyi'],
  rust: ['*.rs'],
  go: ['*.go'],
  java: ['*.java'],
  kotlin: ['*.kt', '*.kts'],
  scala: ['*.scala'],
  c: ['*.c', '*.h'],
  cpp: ['*.cpp', '*.cc', '*.cxx', '*.hpp', '*.hh', '*.hxx', '*.h'],
  csharp: ['*.cs'],
  ruby: ['*.rb'],
  php: ['*.php'],
  swift: ['*.swift'],
  json: ['*.json'],
  yaml: ['*.yaml', '*.yml'],
  toml: ['*.toml'],
  xml: ['*.xml'],
  html: ['*.html', '*.htm'],
  css: ['*.css', '*.scss', '*.less'],
  md: ['*.md', '*.markdown'],
  markdown: ['*.md', '*.markdown'],
  sh: ['*.sh', '*.bash'],
  shell: ['*.sh', '*.bash'],
  sql: ['*.sql'],
};

/** Returns the basename globs for a type name, or undefined when unmapped. */
export function resolveTypeFilterGlobs(fileType?: string): string[] | undefined {
  if (!fileType) return undefined;
  const globs = TYPE_FILTER_GLOBS[String(fileType).toLowerCase()];
  return globs ? [...globs] : undefined;
}

const GREP_MATCHER_WORKER_SOURCE = [
  "const { parentPort } = require('worker_threads');",
  'let regex = null;',
  "parentPort.on('message', (msg) => {",
  "  if (!msg || typeof msg !== 'object') return;",
  "  if (msg.kind === 'init') {",
  '    try {',
  "      regex = new RegExp(String(msg.pattern), String(msg.flags || ''));",
  "      parentPort.postMessage({ kind: 'ready' });",
  '    } catch (error) {',
  "      parentPort.postMessage({ kind: 'error', code: 'INVALID_PATTERN', message: String((error && error.message) || error) });",
  '    }',
  '    return;',
  '  }',
  "  if (msg.kind === 'match') {",
  '    const raw = msg.text;',
  "    const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');",
  "    const lines = text.split('\\n');",
  '    const max = Number(msg.maxLines) || 0;',
  '    const matched = [];',
  '    for (let i = 0; i < lines.length; i++) {',
  '      if (regex.test(lines[i])) {',
  '        matched.push(i);',
  '        if (max > 0 && matched.length >= max) break;',
  '      }',
  '    }',
  "    parentPort.postMessage({ kind: 'result', id: msg.id, matched });",
  '  }',
  '});',
].join('\n');

interface PendingMatch {
  resolve: (matched: number[]) => void;
  reject: (error: GrepSearchError) => void;
}

/**
 * Runs pattern matching inside a worker isolate so adversarial (catastrophic
 * backtracking) regex can never block the main-thread event loop or the
 * deadline timer. The worker is supervised by the same GrepDeadline: when the
 * deadline or caller abort fires, the worker is terminated and every pending
 * match rejects with the typed terminal error.
 */
export class GrepMatcher {
  private readonly deadline: GrepDeadline;
  private readonly pattern: string;
  private readonly flags: string;
  private worker?: Worker;
  private readyPromise?: Promise<void>;
  private pendingInit?: { resolve: () => void; reject: (error: GrepSearchError) => void };
  private readonly pending = new Map<number, PendingMatch>();
  private nextId = 1;
  private disposed = false;
  private abortHandler?: () => void;

  constructor(pattern: string, flags: string, deadline: GrepDeadline) {
    this.pattern = pattern;
    this.flags = flags;
    this.deadline = deadline;
  }

  private terminalError(): GrepSearchError {
    return this.deadline.reasonType === 'timeout'
      ? new GrepTimeoutError(this.deadline.budgetMs)
      : new GrepCancelledError();
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(GREP_MATCHER_WORKER_SOURCE, { eval: true });
    worker.unref();
    worker.on('message', (msg: any) => this.handleMessage(msg));
    worker.on('error', (error: Error) => {
      this.rejectAll(new GrepBackendError(`匹配线程异常: ${error.message}`));
    });
    worker.on('exit', () => {
      if (this.worker === worker) this.worker = undefined;
      this.rejectAll(new GrepBackendError('匹配线程已退出'));
    });
    this.abortHandler = () => this.dispose(this.terminalError());
    this.deadline.signal.addEventListener('abort', this.abortHandler, { once: true });
    this.worker = worker;
    return worker;
  }

  private handleMessage(msg: any): void {
    if (!msg || typeof msg !== 'object') return;
    if (msg.kind === 'ready') {
      this.pendingInit?.resolve();
      this.pendingInit = undefined;
      return;
    }
    if (msg.kind === 'error') {
      const error = msg.code === 'INVALID_PATTERN'
        ? new GrepInvalidPatternError(String(msg.message || msg.code))
        : new GrepBackendError(String(msg.message || '匹配线程错误'));
      this.pendingInit?.reject(error);
      this.pendingInit = undefined;
      this.rejectAll(error);
      return;
    }
    if (msg.kind === 'result') {
      const pending = this.pending.get(Number(msg.id));
      if (pending) {
        this.pending.delete(Number(msg.id));
        pending.resolve(Array.isArray(msg.matched) ? msg.matched.map(Number) : []);
      }
    }
  }

  private rejectAll(error: GrepSearchError): void {
    const pendingInit = this.pendingInit;
    this.pendingInit = undefined;
    pendingInit?.reject(error);
    for (const [, pending] of this.pending) pending.reject(error);
    this.pending.clear();
  }

  /** Compile the pattern inside the worker; rejects with GrepInvalidPatternError. */
  async ensureReady(): Promise<void> {
    if (this.disposed) throw new GrepCancelledError();
    if (!this.readyPromise) {
      const worker = this.ensureWorker();
      this.readyPromise = new Promise<void>((resolve, reject) => {
        this.pendingInit = { resolve, reject };
        worker.postMessage({ kind: 'init', pattern: this.pattern, flags: this.flags });
      });
    }
    return this.readyPromise;
  }

  /**
   * Match one file's text. Returns matching line indexes (0-based). The worker
   * stops after `maxLines` matches (0 = unlimited, used by count mode).
   */
  async match(text: string | Uint8Array, maxLines: number): Promise<number[]> {
    this.deadline.check();
    await this.ensureReady();
    this.deadline.check();
    if (this.disposed) throw new GrepCancelledError();
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<number[]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ kind: 'match', id, text, maxLines });
    });
  }

  dispose(reason?: GrepSearchError): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.abortHandler) {
      this.deadline.signal.removeEventListener('abort', this.abortHandler);
      this.abortHandler = undefined;
    }
    this.rejectAll(reason ?? this.terminalError());
    const worker = this.worker;
    this.worker = undefined;
    if (worker) {
      worker.terminate().catch(() => { /* already gone */ });
    }
  }
}

/**
 * Backend timing seam: records one entry per backend attempt. The rendered
 * payload is enum/numeric only — backend names, durations, outcome enums —
 * never paths, patterns or content.
 */
export class GrepTimingCollector {
  private readonly startedAt = Date.now();
  private readonly entries: Array<{
    backend: GrepBackendName;
    outcome: GrepBackendOutcome;
    durationMs: number;
  }> = [];

  record(backend: GrepBackendName, outcome: GrepBackendOutcome, durationMs: number): void {
    this.entries.push({ backend, outcome, durationMs });
  }

  format(): string {
    const lines = this.entries.map(
      entry => `${entry.backend}: ${Math.max(0, entry.durationMs | 0)}ms (${entry.outcome})`,
    );
    return [`[backend timing]`, ...lines, `total: ${Math.max(0, Date.now() - this.startedAt)}ms`].join('\n');
  }
}

export function outcomeForError(error: GrepSearchError): GrepBackendOutcome {
  if (error instanceof GrepTimeoutError) return 'timeout';
  if (error instanceof GrepCancelledError) return 'cancelled';
  if (error instanceof GrepOverflowError) return 'overflow';
  if (error instanceof GrepInvalidPatternError) return 'invalid_pattern';
  if (error instanceof GrepUnsupportedTypeError) return 'unsupported_type';
  return 'error';
}
