/**
 * GrepTool runtime helpers: one absolute deadline shared by every local search
 * backend, typed terminal outcomes, bounded child-process execution, a worker
 * isolate for adversarial regex matching, a linear (non-backtracking) glob
 * engine, native-grep include planning, and the backend timing seam.
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
  | 'unsupported_type'
  | 'skipped';

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

/**
 * Internal-only: the native grep backend cannot express the requested filter
 * combination (brace/path glob, glob∧type AND). Never surfaces to the caller —
 * the chain continues with the capable Node backend.
 */
export class GrepFilterNotExpressedError extends GrepSearchError {
  constructor(reason: string) {
    super('FILTER_NOT_EXPRESSED_NATIVE', reason);
    this.name = 'GrepFilterNotExpressedError';
  }
}

/**
 * The search root itself is unreadable (EACCES/EPERM). Terminal: a fallback
 * would just fail again, and returning "no matches" would be a false empty.
 */
export class GrepRootAccessError extends GrepSearchError {
  constructor(path: string, detail: string) {
    super('PERMISSION_DENIED', `搜索根目录无读取权限: ${path}${detail ? ` (${detail})` : ''}。结果不完整，已停止搜索而不是返回空匹配。`);
    this.name = 'GrepRootAccessError';
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
  private readonly rejected: Promise<never>;
  private rejectFn?: (error: GrepSearchError) => void;
  private timer: NodeJS.Timeout | undefined;
  private callerSignal?: AbortSignal;
  private callerHandler?: () => void;
  private fired?: DeadlineReason;

  constructor(budgetMs: number, callerSignal?: AbortSignal) {
    this.budgetMs = budgetMs;
    // Deferred rejection so plain promises (fs.stat/readdir without signal
    // support, worker round-trips) can race against the deadline and settle
    // promptly even when the underlying IO itself cannot be cancelled.
    this.rejected = new Promise<never>((_, reject) => {
      this.rejectFn = reject;
    });
    this.rejected.catch(() => { /* handled wherever raced; avoids unhandledRejection */ });
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
    this.rejectFn?.(reason === 'timeout'
      ? new GrepTimeoutError(this.budgetMs)
      : new GrepCancelledError());
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

  /**
   * Race an un-cancellable IO promise against the deadline. The loser keeps
   * running in the background (Promise.race already holds handlers for it, so
   * a late rejection cannot become unhandled), but the caller settles typed
   * and no further backend or read is started after expiry.
   */
  race<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([promise, this.rejected]);
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

// ---------------------------------------------------------------------------
// Glob engine — linear Thompson-NFA simulation.
//
// A RegExp compiled from a user glob (`a*a*…b`, nested duplicate braces) can
// backtrack catastrophically on the main event loop and block the deadline
// timer. The NFA simulation below is O(len × states) with no backtracking, so
// adversarial globs cannot stall the search or the loop.
// ---------------------------------------------------------------------------

interface GlobNfa {
  start: number;
  accepting: number;
  epsilon: number[][];
  chars: Array<Array<{ ch: string; to: number }>>;
  any: Array<Array<{ slashOk: boolean; to: number }>>;
}

export interface GrepGlobMatcher {
  source: string;
  nfa: GlobNfa;
  /** Globs containing '/' match the path relative to the search root; others match basenames. */
  matchAgainstPath: boolean;
}

function createNfa(): { nfa: GlobNfa; newState: () => number } {
  const nfa: GlobNfa = { start: 0, accepting: 0, epsilon: [], chars: [], any: [] };
  const newState = (): number => {
    nfa.epsilon.push([]);
    nfa.chars.push([]);
    nfa.any.push([]);
    return nfa.epsilon.length - 1;
  };
  return { nfa, newState };
}

interface GlobFragment { start: number; end: number; }

function parseGlobSequence(glob: string, cursor: { i: number }, topLevel: boolean, build: { nfa: GlobNfa; newState: () => number }): GlobFragment {
  let joined: GlobFragment | undefined;
  const link = (piece: GlobFragment): void => {
    if (!joined) {
      joined = piece;
      return;
    }
    build.nfa.epsilon[joined.end].push(piece.start);
    joined = { start: joined.start, end: piece.end };
  };

  while (cursor.i < glob.length) {
    const ch = glob[cursor.i];
    if (!topLevel && (ch === ',' || ch === '}')) break;
    cursor.i += 1;

    if (ch === '*') {
      const globstar = glob[cursor.i] === '*';
      if (globstar) while (glob[cursor.i] === '*') cursor.i += 1;
      const state = build.newState();
      const exit = build.newState();
      build.nfa.any[state].push({ slashOk: globstar, to: state });
      build.nfa.epsilon[state].push(exit);
      link({ start: state, end: exit });
    } else if (ch === '?') {
      const state = build.newState();
      const exit = build.newState();
      build.nfa.any[state].push({ slashOk: false, to: exit });
      link({ start: state, end: exit });
    } else if (ch === '{') {
      const branches: GlobFragment[] = [];
      for (;;) {
        branches.push(parseGlobSequence(glob, cursor, false, build));
        if (glob[cursor.i] === ',') {
          cursor.i += 1;
          continue;
        }
        if (glob[cursor.i] === '}') cursor.i += 1; // unbalanced braces degrade to literal end
        break;
      }
      const enter = build.newState();
      const exit = build.newState();
      for (const branch of branches) {
        build.nfa.epsilon[enter].push(branch.start);
        build.nfa.epsilon[branch.end].push(exit);
      }
      link({ start: enter, end: exit });
    } else {
      const state = build.newState();
      const exit = build.newState();
      build.nfa.chars[state].push({ ch, to: exit });
      link({ start: state, end: exit });
    }
  }

  if (!joined) {
    const state = build.newState();
    return { start: state, end: state };
  }
  return joined;
}

function epsilonClosure(nfa: GlobNfa, states: Set<number>): Set<number> {
  const stack = [...states];
  while (stack.length) {
    const state = stack.pop() as number;
    for (const target of nfa.epsilon[state]) {
      if (!states.has(target)) {
        states.add(target);
        stack.push(target);
      }
    }
  }
  return states;
}

function nfaAccepts(nfa: GlobNfa, value: string): boolean {
  let current = epsilonClosure(nfa, new Set<number>([nfa.start]));
  for (const ch of value) {
    const next = new Set<number>();
    for (const state of current) {
      for (const edge of nfa.chars[state]) {
        if (edge.ch === ch) next.add(edge.to);
      }
      for (const edge of nfa.any[state]) {
        if (edge.slashOk || ch !== '/') next.add(edge.to);
      }
    }
    if (next.size === 0) return false;
    current = epsilonClosure(nfa, next);
  }
  return current.has(nfa.accepting);
}

/** Compile a user glob ("*.js", "*.{ts,tsx}", "src/x/**" / "*.d.ts") into a linear matcher. */
export function compileGlob(glob: string): GrepGlobMatcher {
  const build = createNfa();
  const whole = parseGlobSequence(glob, { i: 0 }, true, build);
  build.nfa.start = whole.start;
  build.nfa.accepting = whole.end;
  return {
    source: glob,
    nfa: build.nfa,
    matchAgainstPath: glob.includes('/'),
  };
}

export function matchGlob(
  matcher: GrepGlobMatcher,
  relativePath: string,
  basename: string,
): boolean {
  return matcher.matchAgainstPath
    ? nfaAccepts(matcher.nfa, relativePath)
    : nfaAccepts(matcher.nfa, basename);
}

/**
 * AND-combined filter set shared by the single-file pre-check and the Node
 * walk: the user glob (when present) AND the type group (alternatives within a
 * group are OR, groups are AND) — matching ripgrep semantics.
 */
export interface SearchFilters {
  isAllowed(relativePath: string, basename: string): boolean;
}

export function compileSearchFilters(
  globPattern: string | undefined,
  fileTypeGlobs: string[] | undefined,
): SearchFilters {
  const globMatcher = globPattern ? compileGlob(globPattern) : undefined;
  const typeMatchers = (fileTypeGlobs ?? []).map(compileGlob);
  return {
    isAllowed(relativePath: string, basename: string): boolean {
      if (globMatcher && !matchGlob(globMatcher, relativePath, basename)) return false;
      if (typeMatchers.length > 0 && !typeMatchers.some(matcher => matchGlob(matcher, relativePath, basename))) return false;
      return true;
    },
  };
}

/**
 * Expand top-level (and nested) brace alternatives into concrete globs:
 * "*.{ts,tsx}" → ["*.ts", "*.tsx"]. Returns undefined when expansion would
 * exceed maxResults (caller should not feed the native backend).
 */
export function expandGlobAlternatives(glob: string, maxResults = 16): string[] | undefined {
  const expand = (input: string): string[] => {
    const open = input.indexOf('{');
    if (open === -1) return [input];
    let depth = 0;
    let close = -1;
    for (let i = open; i < input.length; i += 1) {
      if (input[i] === '{') depth += 1;
      else if (input[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close === -1) return [input]; // unbalanced → literal
    const prefix = input.slice(0, open);
    const inner = input.slice(open + 1, close);
    const suffix = input.slice(close + 1);
    const alternatives: string[] = [];
    let innerDepth = 0;
    let current = '';
    for (const ch of inner) {
      if (ch === '{') innerDepth += 1;
      if (ch === '}') innerDepth -= 1;
      if (ch === ',' && innerDepth === 0) {
        alternatives.push(current);
        current = '';
        continue;
      }
      current += ch;
    }
    alternatives.push(current);
    const out: string[] = [];
    for (const alternative of alternatives) {
      for (const expanded of expand(prefix + alternative + suffix)) out.push(expanded);
    }
    return out;
  };
  const results = expand(glob);
  return results.length > maxResults ? undefined : results;
}

/** fnmatch-style globs only: no path separators, no braces, no character classes. */
function nativeGlobSafe(glob: string): boolean {
  return !glob.includes('/') && !glob.includes('{') && !glob.includes('}')
    && !glob.includes('[') && !glob.includes(']');
}

/**
 * Plan --include flags for the native grep backend. grep's --include list is
 * OR-ed, while the user glob AND the type filter must intersect (ripgrep
 * semantics). A combination is natively expressible only when at most one AND
 * group is present, every expanded alternative is fnmatch-safe, and the list
 * stays small. Otherwise returns undefined → route to the exact Node backend.
 */
export function planNativeIncludes(
  globPattern: string | undefined,
  fileTypeGlobs: string[] | undefined,
): string[] | undefined {
  if (globPattern && fileTypeGlobs && fileTypeGlobs.length > 0) return undefined; // AND not expressible as OR
  const group = globPattern
    ? expandGlobAlternatives(globPattern)
    : (fileTypeGlobs ? [...fileTypeGlobs] : []);
  if (!group) return undefined;
  if (group.length === 0) return [];
  if (group.length > 16) return undefined;
  for (const glob of group) {
    if (!nativeGlobSafe(glob)) return undefined;
  }
  return group;
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

/**
 * Pattern constructs POSIX ERE (grep -E) cannot honor with ripgrep/JS
 * semantics: class escapes (\d \D \w \W \s \S \b \B) and any (?…) group
 * ((?:, (?=, (?!, (?<=, (?!, (?i)…). Matching them natively silently changes
 * meaning (\d becomes literal 'd') or misparses ((?:foo) becomes a literal
 * string) — potentially a false "no match". Such patterns must go to the
 * isolated Node backend or fail visibly.
 */
const NATIVE_INCOMPATIBLE_PATTERN_RE = /\\[dDwWsSbB]|\(\?/;

export function isPatternNativeIncompatible(pattern: string): boolean {
  return NATIVE_INCOMPATIBLE_PATTERN_RE.test(pattern);
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
  '    return;',
  '  }',
  "  if (msg.kind === 'count') {",
  '    const raw = msg.text;',
  "    const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');",
  "    const lines = text.split('\\n');",
  '    let count = 0;',
  '    for (let i = 0; i < lines.length; i++) {',
  '      if (regex.test(lines[i])) count += 1;',
  '    }',
  "    parentPort.postMessage({ kind: 'result', id: msg.id, count });",
  '  }',
  '});',
].join('\n');

interface PendingMatch {
  resolve: (value: number[] | number) => void;
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
        if (msg.count !== undefined) {
          pending.resolve(Number(msg.count));
        } else {
          pending.resolve(Array.isArray(msg.matched) ? msg.matched.map(Number) : []);
        }
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
   * stops after `maxLines` matches (0 = unlimited). Use count() when only the
   * number of matching lines is needed — it never materializes an index array.
   */
  async match(text: string | Uint8Array, maxLines: number): Promise<number[]> {
    this.deadline.check();
    await this.ensureReady();
    this.deadline.check();
    if (this.disposed) throw new GrepCancelledError();
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<number[]>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: number[] | number) => void, reject });
      worker.postMessage({ kind: 'match', id, text, maxLines });
    });
  }

  /** Integer per-file match count for count mode — no per-line index array. */
  async count(text: string | Uint8Array): Promise<number> {
    this.deadline.check();
    await this.ensureReady();
    this.deadline.check();
    if (this.disposed) throw new GrepCancelledError();
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<number>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: number[] | number) => void, reject });
      worker.postMessage({ kind: 'count', id, text });
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
  if (error instanceof GrepFilterNotExpressedError) return 'skipped';
  return 'error';
}
