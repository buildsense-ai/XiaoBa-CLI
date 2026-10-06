import { describe, test, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'child_process';
import { performance } from 'perf_hooks';
import { GrepTool } from '../src/tools/grep-tool';
import type { ToolExecutionContext, ToolExecutionResult } from '../src/types/tool';
import {
  GREP_DEFAULT_TIMEOUT_MS,
  GREP_MAX_TIMEOUT_MS,
  GREP_MIN_TIMEOUT_MS,
  resolveGrepSearchTimeoutMs,
} from '../src/tools/grep-search-policy';

/**
 * Independent contract tests for the grep fallback chain.
 *
 * Principles:
 *  - No ambient ripgrep dependence: every tier is forced explicitly via PATH
 *    (grep tier: /usr/bin:/bin — no rg there; node tier: empty dir).
 *  - Shims are plain /bin/sh scripts with absolute /bin/sleep; a short
 *    backup `AbortSignal.timeout` in the execution context bounds any
 *    pre-fix hang. No opaque instrumentation, no calibration loops, no
 *    adversarial regex/glob on the main test event loop (worker + deadline
 *    behavior is covered by tests/grep-deadline-runtime.test.ts).
 *  - Static fixtures only; follow-up proofs for known 3b59629b blockers are
 *    clearly named and stay uncommitted-failing until A's follow-up lands.
 */

const POSIX = process.platform !== 'win32';
const BACKUP_ABORT_MS = 4_000;

let fixtureRoot: string;
let grepTool: GrepTool;
let context: ToolExecutionContext;
const tempDirs: string[] = [];

function newTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `grep-contract-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function writeShim(dir: string, name: string, body: string): void {
  const shimPath = path.join(dir, name);
  fs.writeFileSync(shimPath, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(shimPath, 0o755);
}

/** PATH that hides rg but keeps the real system grep (forced grep tier). */
function grepTierPath(shimDir: string): string {
  if (!fs.existsSync('/usr/bin/rg')) {
    return '/usr/bin:/bin';
  }
  // Portability fallback: shadow rg with an "unavailable" shim (exit 127),
  // which the chain treats as a backend failure and falls through.
  writeShim(shimDir, 'rg', 'echo "rg unavailable" >&2\nexit 127');
  return `${shimDir}${path.delimiter}/usr/bin${path.delimiter}/bin`;
}

/** PATH that hides both rg and grep (forced Node tier). */
function nodeTierPath(): string {
  return newTempDir('emptybin');
}

async function withForcedPath<T>(envPath: string, fn: () => Promise<T>): Promise<T> {
  const originalPath = process.env.PATH;
  process.env.PATH = envPath;
  try {
    return await fn();
  } finally {
    process.env.PATH = originalPath;
  }
}

function buildFixture(): void {
  fixtureRoot = newTempDir('fixture');
  fs.writeFileSync(path.join(fixtureRoot, 'text1.js'), 'function hello() {\n  console.log("Hello World");\n}\n');
  fs.writeFileSync(path.join(fixtureRoot, 'text2.ts'), 'const greeting = "Hello";\n');
  fs.writeFileSync(path.join(fixtureRoot, 'text3.py'), 'def hello():\n    print("printpy")\n');
  fs.writeFileSync(path.join(fixtureRoot, 'dash.txt'), '-v flag text\n');
  fs.writeFileSync(path.join(fixtureRoot, 'look.txt'), 'Hello World\nHello sunny\n');
  fs.writeFileSync(path.join(fixtureRoot, 'digits.txt'), '123\n');
  fs.writeFileSync(path.join(fixtureRoot, 'count5.txt'), Array.from({ length: 5 }, (_, i) => `needle ${i}`).join('\n') + '\n');
  fs.writeFileSync(path.join(fixtureRoot, 'big300.txt'), Array.from({ length: 300 }, (_, i) => `needle ${i}`).join('\n') + '\n');
  fs.writeFileSync(path.join(fixtureRoot, 'longline.txt'), `pad ${'x'.repeat(120 * 1024)} deepmarker\n`);

  const nested = path.join(fixtureRoot, 'notes');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, 'count5.txt'), Array.from({ length: 5 }, (_, i) => `needle ${i}`).join('\n') + '\n');
  fs.writeFileSync(path.join(nested, 'big300.txt'), Array.from({ length: 300 }, (_, i) => `needle ${i}`).join('\n') + '\n');

  const unicodeDir = path.join(fixtureRoot, '中文目录');
  fs.mkdirSync(unicodeDir);
  fs.writeFileSync(path.join(unicodeDir, 'unicode.txt'), '问候 greeting 你好 🐱\nCJK 匹配行 emoji 🐾\n');
}

/** Dedicated FIFO fixture so tier semantic tests never touch a FIFO. */
function buildFifoFixture(): string {
  const dir = newTempDir('fifo-fixture');
  fs.writeFileSync(path.join(dir, 'count5.txt'), Array.from({ length: 5 }, (_, i) => `needle ${i}`).join('\n') + '\n');
  if (POSIX) {
    execFileSync('/usr/bin/mkfifo', [path.join(dir, 'fippy.fifo')]);
  }
  return dir;
}

function messageOf(result: ToolExecutionResult): string {
  return result.ok ? String(result.content) : result.message;
}

async function executeInTier(
  envPath: string,
  args: Record<string, unknown>,
  overrides: Partial<ToolExecutionContext> = {},
): Promise<ToolExecutionResult> {
  return withForcedPath(envPath, () => grepTool.execute(args, { ...context, ...overrides })) as Promise<ToolExecutionResult>;
}

function assertNeverNoMatch(result: ToolExecutionResult): void {
  assert.ok(!/未找到匹配项/.test(messageOf(result)), `incomplete search must never be reported as no-match: ${messageOf(result)}`);
}

before(() => {
  buildFixture();
  grepTool = new GrepTool();
  context = { workingDirectory: fixtureRoot, surface: 'cli' };
});

after(() => {
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('grep fallback contract: policy wiring', () => {
  test('default deadline is the shared policy default; bounds clamp to [100, 30000]', () => {
    assert.equal(resolveGrepSearchTimeoutMs(), GREP_DEFAULT_TIMEOUT_MS);
    assert.equal(GREP_DEFAULT_TIMEOUT_MS, 15_000);
    assert.equal(resolveGrepSearchTimeoutMs(GREP_MIN_TIMEOUT_MS), GREP_MIN_TIMEOUT_MS);
    assert.equal(resolveGrepSearchTimeoutMs(GREP_MAX_TIMEOUT_MS), GREP_MAX_TIMEOUT_MS);
    assert.throws(() => resolveGrepSearchTimeoutMs(GREP_MIN_TIMEOUT_MS - 1), RangeError);
    assert.throws(() => resolveGrepSearchTimeoutMs(GREP_MAX_TIMEOUT_MS + 1), RangeError);
  });
});

describe('grep fallback contract: deadline, timeout, cancellation', () => {
  test('injected timeout_ms bounds a hung search and is typed SEARCH_TIMEOUT', { timeout: 15_000 }, async () => {
    if (!POSIX) return;
    const shimDir = newTempDir('shims');
    writeShim(shimDir, 'rg', '/bin/sleep 2\n');
    const start = performance.now();
    const result = await executeInTier(
      shimDir,
      { pattern: 'Hello', output_mode: 'files', timeout_ms: 300 },
      { abortSignal: AbortSignal.timeout(BACKUP_ABORT_MS) },
    );
    const elapsed = performance.now() - start;
    assert.ok(!result.ok, `hung search must fail typed, got ok=true`);
    if (!result.ok) {
      assert.equal(result.errorCode, 'SEARCH_TIMEOUT', `expected SEARCH_TIMEOUT, got ${result.errorCode}: ${result.message}`);
    }
    assertNeverNoMatch(result);
    assert.ok(elapsed < BACKUP_ABORT_MS, `SEARCH_TIMEOUT must win before the backup abort, took ${Math.round(elapsed)}ms`);
  });

  test('deadline is absolute across fallback tiers, not per-tier', { timeout: 15_000 }, async () => {
    if (!POSIX) return;
    const shimDir = newTempDir('shims');
    for (const name of ['rg', 'grep']) {
      writeShim(shimDir, name, '/bin/sleep 2\nexit 2\n');
    }
    const start = performance.now();
    const result = await executeInTier(
      shimDir,
      { pattern: 'Hello', output_mode: 'files', timeout_ms: 1_500 },
      { abortSignal: AbortSignal.timeout(BACKUP_ABORT_MS + 2_000) },
    );
    const elapsed = performance.now() - start;
    assert.ok(!result.ok, 'slow-failing chain must end typed');
    if (!result.ok) {
      assert.equal(result.errorCode, 'SEARCH_TIMEOUT', `expected SEARCH_TIMEOUT, got ${result.errorCode}`);
    }
    assert.ok(elapsed < 5_000, `single absolute deadline expected (~1.5s + kill slack), took ${Math.round(elapsed)}ms; per-tier windows would need >=4s`);
  });

  test('malformed timeout_ms fails closed as INVALID_TOOL_ARGUMENTS', { timeout: 15_000 }, async () => {
    const envPath = nodeTierPath();
    for (const bad of [0, 99, GREP_MAX_TIMEOUT_MS + 1, '1000', 100.5, null]) {
      const result = await executeInTier(envPath, { pattern: 'needle', output_mode: 'files', timeout_ms: bad });
      assert.ok(!result.ok, `timeout_ms=${JSON.stringify(bad)} must be rejected, got ok=true`);
      if (!result.ok) {
        assert.equal(result.errorCode, 'INVALID_TOOL_ARGUMENTS', `malformed budget must be INVALID_TOOL_ARGUMENTS, got ${result.errorCode}`);
        assert.match(result.message, /timeout_ms/, `rejection should mention timeout_ms, got: ${result.message}`);
      }
    }
  });

  test('boundary timeout_ms values are valid: never INVALID_TOOL_ARGUMENTS', { timeout: 15_000 }, async () => {
    const envPath = nodeTierPath();
    for (const good of [GREP_MIN_TIMEOUT_MS, GREP_MAX_TIMEOUT_MS]) {
      // timeout_ms=100 acceptance does not guarantee completion under load:
      // SEARCH_TIMEOUT is an acceptable outcome, rejection is not.
      const result = await executeInTier(envPath, { pattern: 'needle', output_mode: 'files', timeout_ms: good });
      assert.ok(
        !(result.ok === false && result.errorCode === 'INVALID_TOOL_ARGUMENTS'),
        `timeout_ms=${good} is in range and must not be rejected, got: ${(!result.ok && result.message) || ''}`,
      );
    }
  });

  test('cancellation during tier 1 is typed SEARCH_CANCELLED and stops the chain', { timeout: 15_000 }, async () => {
    if (!POSIX) return;
    const shimDir = newTempDir('shims');
    writeShim(shimDir, 'rg', '/bin/sleep 2\n');
    writeShim(shimDir, 'grep', '/bin/sleep 2\n');
    const controller = new AbortController();
    const killer = setTimeout(() => controller.abort(), 250);
    const start = performance.now();
    try {
      const result = await executeInTier(
        shimDir,
        { pattern: 'Hello', output_mode: 'files' },
        { abortSignal: controller.signal },
      );
      const elapsed = performance.now() - start;
      assert.ok(!result.ok, 'cancelled search must not succeed');
      if (!result.ok) {
        assert.equal(result.errorCode, 'SEARCH_CANCELLED', `cancellation must be typed SEARCH_CANCELLED, got ${result.errorCode}: ${result.message}`);
      }
      assert.match(messageOf(result), /取消/);
      assert.ok(elapsed < 5_000, `cancellation must stop the chain promptly, took ${Math.round(elapsed)}ms`);
    } finally {
      clearTimeout(killer);
    }
  });
});

describe('grep fallback contract: regex semantics per forced tier', () => {
  const tiers: Array<{ label: string; buildPathEnv: (shimDir: string) => string }> = POSIX
    ? [
        { label: 'grep-tier (rg absent, real system grep)', buildPathEnv: grepTierPath },
        { label: 'node-tier (rg and grep absent)', buildPathEnv: () => nodeTierPath() },
      ]
    : [{ label: 'node-tier (rg and grep absent)', buildPathEnv: () => nodeTierPath() }];

  for (const tier of tiers) {
    describe(tier.label, () => {
      test('ERE alternation and group match across files', { timeout: 10_000 }, async () => {
        const envPath = tier.buildPathEnv(newTempDir('shims'));
        for (const pattern of ['Hello|printpy', '(Hello|printpy)']) {
          const result = await executeInTier(envPath, { pattern, output_mode: 'files' });
          const text = messageOf(result);
          assert.ok(result.ok, `pattern ${pattern} must match (ERE), got: ${text}`);
          assert.match(text, /text1\.js/);
          assert.match(text, /text3\.py/);
        }
      });

      test("leading-dash pattern '-v' is matched literally, never parsed as an option", { timeout: 10_000 }, async () => {
        const envPath = tier.buildPathEnv(newTempDir('shims'));
        const result = await executeInTier(
          envPath,
          { pattern: '-v', output_mode: 'files' },
          { abortSignal: AbortSignal.timeout(BACKUP_ABORT_MS) },
        );
        assert.ok(result.ok, `pattern '-v' must be searched literally, got: ${messageOf(result)}`);
        assert.match(messageOf(result), /dash\.txt/);
      });

      test('case_insensitive matches across cases', { timeout: 10_000 }, async () => {
        const envPath = tier.buildPathEnv(newTempDir('shims'));
        const result = await executeInTier(envPath, { pattern: 'HELLO', output_mode: 'files', case_insensitive: true });
        const text = messageOf(result);
        assert.ok(result.ok && /text1\.js/.test(text), `case_insensitive must match, got: ${text}`);
      });

      test('type filter is fail-closed: never returns non-requested types', { timeout: 10_000 }, async () => {
        const envPath = tier.buildPathEnv(newTempDir('shims'));
        const scoped = await executeInTier(envPath, { pattern: 'printpy', output_mode: 'files', type: 'py' });
        const scopedText = messageOf(scoped);
        assert.ok(scoped.ok, `type=py must still find py content, got: ${scopedText}`);
        assert.match(scopedText, /text3\.py/);
        assert.doesNotMatch(scopedText, /text1\.js|text2\.ts/, 'type=py must not return other file types');

        const wrong = await executeInTier(envPath, { pattern: 'Hello', output_mode: 'files', type: 'py' });
        const wrongText = messageOf(wrong);
        assert.ok(
          !wrong.ok || !/text1\.js|text2\.ts/.test(wrongText),
          `type=py must not silently widen to js/ts content, got: ${wrongText}`,
        );

        const invalid = await executeInTier(envPath, { pattern: 'Hello', output_mode: 'files', type: 'notarealtype' });
        assert.ok(!invalid.ok, `invalid type must fail closed, got ok=true: ${messageOf(invalid).slice(0, 200)}`);
      });

      test('glob filtering happens before expensive reads (FIFO in tree must not block)', { timeout: 15_000 }, async () => {
        if (!POSIX) return;
        const envPath = tier.buildPathEnv(newTempDir('shims'));
        const fifoDir = buildFifoFixture();
        const start = performance.now();
        const result = await executeInTier(
          envPath,
          { pattern: 'needle', output_mode: 'files', glob: '*.txt', timeout_ms: 800 },
          { workingDirectory: fifoDir, abortSignal: AbortSignal.timeout(BACKUP_ABORT_MS) },
        );
        const elapsed = performance.now() - start;
        const text = messageOf(result);
        assert.ok(result.ok, `glob *.txt must keep a fast successful path (FIFO excluded before reads), got: ${text}`);
        assert.match(text, /count5\.txt/);
        assert.ok(elapsed < BACKUP_ABORT_MS, `glob must prevent expensive reads: a scan opening fippy.fifo cannot finish this fast, took ${Math.round(elapsed)}ms`);
      });

      test('glob brace expansion {js,ts}: known positives must be found or explicitly errored', { timeout: 15_000 }, async () => {
        const envPath = tier.buildPathEnv(newTempDir('shims'));
        const result = await executeInTier(envPath, { pattern: 'Hello', output_mode: 'files', glob: '*.{js,ts}' });
        const text = messageOf(result);
        const found = result.ok && /text1\.js/.test(text) && /text2\.ts/.test(text);
        // Known-positive fixture: both files match the glob and the pattern.
        // A successful no-match here is a fake empty (e.g. native --include
        // not expanding braces) and can never be called honest — the filter
        // must be expanded/routed or rejected with a typed error.
        if (!found) {
          assert.ok(!result.ok, `[${tier.label}] '*.{js,ts}' must find text1.js + text2.ts, or fail typed — got ok=true: ${text}`);
        } else {
          assert.doesNotMatch(text, /text3\.py|digits\.txt/);
        }
      });

      test('invalid regex is a typed INVALID_PATTERN, never a fake no-match', { timeout: 10_000 }, async () => {
        const envPath = tier.buildPathEnv(newTempDir('shims'));
        const result = await executeInTier(
          envPath,
          { pattern: '[unclosed', output_mode: 'files' },
          { abortSignal: AbortSignal.timeout(BACKUP_ABORT_MS) },
        );
        assert.ok(!result.ok, `invalid regex must error, got ok=true: ${messageOf(result).slice(0, 200)}`);
        if (!result.ok) {
          assert.equal(result.errorCode, 'INVALID_PATTERN', `expected INVALID_PATTERN, got ${result.errorCode}: ${result.message}`);
        }
        assertNeverNoMatch(result);
      });

      test('lookahead pattern stays honest: supported tier finds it, no fake no-match', { timeout: 10_000 }, async () => {
        const envPath = tier.buildPathEnv(newTempDir('shims'));
        const result = await executeInTier(
          envPath,
          { pattern: 'Hello(?! World)', output_mode: 'files' },
          { abortSignal: AbortSignal.timeout(BACKUP_ABORT_MS) },
        );
        const text = messageOf(result);
        // look.txt has 'Hello sunny' (match) and 'Hello World' (excluded by
        // the lookahead). rg rejects lookarounds, grep -E rejects them; the
        // chain must end at the JS tier or a typed error — never a fake
        // empty answer that hides a real match.
        if (result.ok) {
          assert.match(text, /look\.txt/, `lookahead must find 'Hello sunny', got: ${text}`);
        }
        assertNeverNoMatch(result);
      });
    });
  }
});

describe('grep fallback contract: counts, caps, unicode, bounded resources', () => {
  test('count mode reports true per-file match counts', { timeout: 10_000 }, async () => {
    const envPath = nodeTierPath();
    const result = await executeInTier(envPath, { pattern: 'needle', output_mode: 'count', glob: 'notes/count5.txt' });
    const text = messageOf(result);
    assert.ok(result.ok, `count mode must succeed, got: ${text}`);
    assert.match(text, /5 个匹配/, `notes/count5.txt has exactly 5 'needle' lines, got: ${text}`);
  });

  test('count totals are the true totals for count mode', { timeout: 10_000 }, async () => {
    const envPath = nodeTierPath();
    const result = await executeInTier(envPath, { pattern: 'needle', output_mode: 'count', glob: 'notes/big300.txt' });
    const text = messageOf(result);
    assert.ok(result.ok, `count mode must succeed, got: ${text}`);
    assert.match(text, /300 个匹配/, `300 real matches must be reported, got: ${text}`);
  });

  test('honest no-match is preserved for a valid unique pattern', { timeout: 10_000 }, async () => {
    const envPath = nodeTierPath();
    const unique = `UniqueNoMatch_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const result = await executeInTier(envPath, { pattern: unique, output_mode: 'files' });
    const text = messageOf(result);
    assert.ok(result.ok, `valid no-match must be ok=true, got: ${text}`);
    assert.match(text, /未找到匹配项/);
  });

  test('content mode bounds giant lines with the wired output cap', { timeout: 15_000 }, async () => {
    const envPath = nodeTierPath();
    const result = await executeInTier(envPath, { pattern: 'deepmarker', output_mode: 'content', glob: 'longline.txt' });
    const text = messageOf(result);
    assert.ok(result.ok, `content mode must succeed, got: ${text.slice(0, 200)}`);
    // The output hook (boundGrepOutput) is wired into withTiming: the whole
    // result is hard-capped at 16k chars with explicit truncation markers.
    assert.ok(text.length <= 16_000, `output hook must cap results at 16k chars, got ${text.length}`);
    assert.match(text, /本行过长，已截断/, 'giant-line truncation must carry the explicit line marker');
  });

  test('unicode content and filenames survive the fallback unchanged', { timeout: 10_000 }, async () => {
    const envPath = nodeTierPath();
    const content = await executeInTier(envPath, { pattern: '你好', output_mode: 'content' });
    const contentText = messageOf(content);
    assert.ok(content.ok, `CJK content search must succeed, got: ${contentText.slice(0, 200)}`);
    assert.match(contentText, /问候 greeting 你好/);
    assert.match(contentText, /🐱/, 'emoji on the matched line must be preserved');

    const files = await executeInTier(envPath, { pattern: 'CJK', output_mode: 'files' });
    const filesText = messageOf(files);
    assert.ok(files.ok, `unicode filename search must succeed, got: ${filesText}`);
    assert.match(filesText, /中文目录\/unicode\.txt/, 'unicode directory and file names must be listed');
  });

  test('symlink directory loop must terminate without widening the scan', { timeout: 10_000 }, async () => {
    if (!POSIX) return;
    const loopDir = newTempDir('looproot');
    fs.writeFileSync(path.join(loopDir, 'inside.txt'), 'loopmarker\n');
    fs.symlinkSync(loopDir, path.join(loopDir, 'self-loop'), 'dir');
    const start = performance.now();
    const result = await executeInTier(
      nodeTierPath(),
      { pattern: 'loopmarker', output_mode: 'files' },
      { workingDirectory: loopDir, abortSignal: AbortSignal.timeout(BACKUP_ABORT_MS) },
    );
    const elapsed = performance.now() - start;
    assert.ok(elapsed < BACKUP_ABORT_MS, `symlink loop must terminate promptly, took ${Math.round(elapsed)}ms`);
    assert.ok(typeof result.ok === 'boolean', 'search completes (either result is acceptable; hanging is not)');
  });

  test('FIFO in tree without glob is skipped or typed timeout, never a hang or fake no-match', { timeout: 15_000 }, async () => {
    if (!POSIX) return;
    const envPath = grepTierPath(newTempDir('shims'));
    const fifoDir = buildFifoFixture();
    const start = performance.now();
    const result = await executeInTier(
      envPath,
      { pattern: 'needle', output_mode: 'files', timeout_ms: 800 },
      { workingDirectory: fifoDir, abortSignal: AbortSignal.timeout(BACKUP_ABORT_MS) },
    );
    const elapsed = performance.now() - start;
    const text = messageOf(result);
    const skipped = result.ok && /count5\.txt/.test(text);
    const timedOut = !result.ok && result.errorCode === 'SEARCH_TIMEOUT';
    assert.ok(
      skipped || timedOut,
      `FIFO must be skipped (matches still found) or deadline-typed, got: ok=${result.ok} errorCode=${(!result.ok && result.errorCode) || '-'} text=${text.slice(0, 200)}`,
    );
    assert.ok(elapsed < BACKUP_ABORT_MS + 1_000, `grep must not hang on FIFOs, took ${Math.round(elapsed)}ms`);
    assertNeverNoMatch(result);
  });
});

describe('grep fallback contract: A-follow-up proofs (blockers in 3b59629b)', () => {
  test('composite glob *.ts + type js is conjunctive: empty on every tier', { timeout: 15_000 }, async () => {
    const cases: Array<[string, () => string]> = [
      ['node-tier', () => nodeTierPath()],
      ...(POSIX ? [['grep-tier', () => grepTierPath(newTempDir('shims'))] as [string, () => string]] : []),
    ];
    for (const [label, envOf] of cases) {
      const result = await executeInTier(envOf(), { pattern: 'Hello', output_mode: 'files', glob: '*.ts', type: 'js' });
      const text = messageOf(result);
      assert.ok(
        !/text1\.js/.test(text) && !/text2\.ts/.test(text),
        `[${label}] glob+type must be AND (no file is both .ts and js-typed), got: ${text}`,
      );
    }
  });

  test('path glob notes/*.txt finds nested files only', { timeout: 15_000 }, async () => {
    const nodeResult = await executeInTier(nodeTierPath(), { pattern: 'needle', output_mode: 'files', glob: 'notes/*.txt' });
    const nodeText = messageOf(nodeResult);
    assert.ok(nodeResult.ok, `[node-tier] path glob must work, got: ${nodeText}`);
    assert.match(nodeText, /notes\/count5\.txt/);
    assert.match(nodeText, /notes\/big300\.txt/);
    assert.doesNotMatch(nodeText, /(^|\s|\d\.\s)count5\.txt/, 'root-level count5.txt must not match notes/*.txt');
    assert.doesNotMatch(nodeText, /digits\.txt|longline\.txt/, 'path glob must exclude non-nested files');

    if (!POSIX) return;
    // Known-positive: notes/count5.txt exists and contains 'needle' — a
    // successful no-match for an expressible filter is a fake empty.
    const grepResult = await executeInTier(grepTierPath(newTempDir('shims')), { pattern: 'needle', output_mode: 'files', glob: 'notes/count5.txt' });
    const grepText = messageOf(grepResult);
    assert.ok(
      (grepResult.ok && /count5\.txt/.test(grepText)) || !grepResult.ok,
      `[grep-tier] path glob must find notes/count5.txt or fail typed, got ok=true: ${grepText}`,
    );
  });

  test('\\d+ matches a digits-only fixture (node strict; grep tier evidence)', { timeout: 15_000 }, async () => {
    const nodeResult = await executeInTier(nodeTierPath(), { pattern: '\\d+', output_mode: 'files', glob: 'digits.txt' });
    const nodeText = messageOf(nodeResult);
    assert.ok(nodeResult.ok && /digits\.txt/.test(nodeText), `[node-tier] \\d+ must match '123', got: ${nodeText}`);

    if (!POSIX) return;
    const grepResult = await executeInTier(grepTierPath(newTempDir('shims')), { pattern: '\\d+', output_mode: 'files', glob: 'digits.txt' });
    const grepText = messageOf(grepResult);
    assert.ok(
      grepResult.ok && /digits\.txt/.test(grepText),
      `[grep-tier] \\d+ must keep digit semantics (rg parity), got: ${grepText} — literal-d fallback is a silent false result`,
    );
  });

  test('unreadable search root must not become a successful empty result', { timeout: 15_000 }, async () => {
    const lockedDir = newTempDir('locked-root');
    fs.writeFileSync(path.join(lockedDir, 'secret.txt'), 'rootperm marker\n');
    const originalReaddir = fs.promises.readdir;
    const originalStat = fs.promises.stat;
    // Stub at the fs layer so the proof is platform-independent (also covers
    // environments running as root where permission bits are not enforced).
    (fs.promises as any).readdir = async (...readdirArgs: any[]) => {
      throw Object.assign(new Error("EACCES: permission denied, scandir '" + lockedDir + "'"), { code: 'EACCES' });
    };
    try {
      const result = await executeInTier(
        nodeTierPath(),
        { pattern: 'rootperm', output_mode: 'files' },
        { workingDirectory: lockedDir, abortSignal: AbortSignal.timeout(BACKUP_ABORT_MS) },
      );
      const text = messageOf(result);
      assert.ok(
        !(result.ok && /未找到匹配项/.test(text)),
        `unreadable root must be a typed backend error, not a silent false empty, got: ${text}`,
      );
      assert.ok(!result.ok, `unreadable root must fail, got ok=true: ${text}`);
      if (!result.ok) {
        // A's follow-up reports the root-permission case as PERMISSION_DENIED
        // with an explicit incompleteness note; SEARCH_BACKEND_ERROR is the
        // generic honest alternative. Both are visibly-failed typed results.
        assert.ok(
          result.errorCode === 'PERMISSION_DENIED' || result.errorCode === 'SEARCH_BACKEND_ERROR',
          `expected a typed failure for the unreadable root, got ${result.errorCode}: ${result.message}`,
        );
        assert.match(result.message, /不完整|无读取权限|权限/, `failure must explain incompleteness, got: ${result.message}`);
      }
    } finally {
      (fs.promises as any).readdir = originalReaddir;
      (fs.promises as any).stat = originalStat;
    }
  });

  test('node-tier files-mode truncation carries an explicit notice', { timeout: 15_000 }, async () => {
    const manyDir = newTempDir('many-files');
    for (let i = 0; i < 300; i++) {
      fs.writeFileSync(path.join(manyDir, `hit-${String(i).padStart(3, '0')}.txt`), `needle ${i}\n`);
    }
    const result = await executeInTier(
      nodeTierPath(),
      { pattern: 'needle', output_mode: 'files' },
      { workingDirectory: manyDir, abortSignal: AbortSignal.timeout(BACKUP_ABORT_MS) },
    );
    const text = messageOf(result);
    assert.ok(result.ok, `files scan must succeed, got: ${text.slice(0, 200)}`);
    const listsAll = /hit-299\.txt/.test(text);
    const marksTruncation = /limit|截断|不完整|未完整/.test(text);
    assert.ok(
      listsAll || marksTruncation,
      `300 matches under default limit: output must list all or explicitly mark truncation, got: ${text.slice(0, 300)}`,
    );
  });

  test('stalled stat metadata is interrupted by the deadline, not just the caller abort', { timeout: 15_000 }, async () => {
    if (!POSIX) return;
    const controller = new AbortController();
    const originalStat = fs.promises.stat;
    let firstCall = true;
    (fs.promises as any).stat = (...statArgs: any[]) => {
      if (!firstCall) return originalStat.apply(fs.promises, statArgs as any);
      firstCall = false;
      // Hangs until the caller aborts — simulates stalled NFS metadata.
      return new Promise<any>((_resolve, reject) => {
        const onAbort = () => reject(Object.assign(new Error('stat aborted'), { name: 'AbortError', code: 'ABORT_ERR' }));
        if (controller.signal.aborted) onAbort();
        else controller.signal.addEventListener('abort', onAbort, { once: true });
      });
    };
    const start = performance.now();
    try {
      const executePromise = executeInTier(
        nodeTierPath(),
        { pattern: 'needle', output_mode: 'files', timeout_ms: 500 },
        { abortSignal: controller.signal },
      );
      // The losing race branch may reject after this test finished (e.g. the
      // deadline fires once the stubbed stat finally aborts). Mark it handled
      // so it cannot crash the test file as an unhandled rejection.
      executePromise.catch(() => { /* raced away */ });
      const raced = await Promise.race([
        executePromise,
        new Promise<'STALLED'>(((resolve) => {
          setTimeout(() => resolve('STALLED'), 6_000);
        })),
      ]);
      const elapsed = performance.now() - start;
      if (raced === 'STALLED') {
        assert.fail(`search still blocked in stalled stat after 6s — metadata awaits are not deadline-bound (took ${Math.round(elapsed)}ms)`);
      }
      const result = raced as ToolExecutionResult;
      assert.ok(!result.ok, 'stalled metadata search must not succeed');
      if (!result.ok) {
        assert.equal(result.errorCode, 'SEARCH_TIMEOUT', `stalled stat must be deadline-typed, got ${result.errorCode}: ${result.message}`);
      }
      assert.ok(elapsed < 3_000, `deadline must bound the stall without waiting for the backup abort, took ${Math.round(elapsed)}ms`);
    } finally {
      (fs.promises as any).stat = originalStat;
      controller.abort();
    }
  });
});

describe('grep fallback contract: second-round glob planner hardening proofs (becca504)', () => {
  test('brace-bomb depth is capped during expansion, not after the crossproduct', { timeout: 15_000 }, async () => {
    // 24 nesting levels of two alternatives = a 2^24 crossproduct IF the
    // implementation expanded before checking the cap (the A5ce flaw). The
    // depth cap must reject it during parsing instead.
    const bomb = '{a,b'.repeat(24) + 'x' + '}'.repeat(24);
    const envPath = nodeTierPath();
    const start = performance.now();
    const result = await executeInTier(envPath, { pattern: 'needle', output_mode: 'files', glob: bomb });
    const elapsed = performance.now() - start;
    assert.ok(!result.ok, `brace bomb must be rejected, got ok=true: ${messageOf(result).slice(0, 200)}`);
    if (!result.ok) {
      assert.equal(result.errorCode, 'INVALID_TOOL_ARGUMENTS', `expected INVALID_TOOL_ARGUMENTS, got ${result.errorCode}: ${result.message}`);
    }
    assert.ok(elapsed < 2_000, `depth cap must fire during parsing (2^24 crossproduct would take far longer), took ${Math.round(elapsed)}ms`);
  });

  test('emoji in composite globs matches by code points on both tiers', { timeout: 15_000 }, async () => {
    const emojiDir = newTempDir('emoji-glob');
    fs.writeFileSync(path.join(emojiDir, '猫🐱note.txt'), 'emojiglob marker\n');
    fs.writeFileSync(path.join(emojiDir, 'plain.txt'), 'emojiglob marker\n');
    const envPath = nodeTierPath();
    for (const glob of ['*.txt', '猫*.txt', '*.{txt,md}']) {
      const result = await executeInTier(
        envPath,
        { pattern: 'emojiglob', output_mode: 'files', glob },
        { workingDirectory: emojiDir },
      );
      const text = messageOf(result);
      assert.ok(result.ok, `[node-tier] glob '${glob}' must work with astral filenames, got: ${text}`);
      assert.match(text, /猫🐱note\.txt/, `[node-tier] glob '${glob}' must match the emoji filename (code-point semantics), got: ${text}`);
    }

    if (!POSIX) return;
    // Known-positive composite brace glob with an astral filename on the
    // native tier: found or typed error, never a fake empty.
    const grepResult = await executeInTier(
      grepTierPath(newTempDir('shims')),
      { pattern: 'emojiglob', output_mode: 'files', glob: '*.{txt,md}' },
      { workingDirectory: emojiDir },
    );
    const grepText = messageOf(grepResult);
    assert.ok(
      (grepResult.ok && /猫🐱note\.txt/.test(grepText)) || !grepResult.ok,
      `[grep-tier] emoji composite glob must find the file or fail typed, got ok=true: ${grepText}`,
    );
  });

  test('bracket classes are honored: known positive found, malformed rejected', { timeout: 15_000 }, async () => {
    const envPath = nodeTierPath();
    const result = await executeInTier(envPath, { pattern: 'Hello', output_mode: 'files', glob: 'text[0-9].js' });
    const text = messageOf(result);
    assert.ok(result.ok, `bracket class glob must succeed, got: ${text}`);
    assert.match(text, /text1\.js/, `text[0-9].js must match text1.js, got: ${text}`);
    assert.doesNotMatch(text, /text2\.ts|text3\.py/);

    const negated = await executeInTier(envPath, { pattern: 'Hello', output_mode: 'files', glob: 'text[!0-9]*' });
    const negatedText = messageOf(negated);
    if (negated.ok && !/未找到匹配项/.test(negatedText)) {
      assert.doesNotMatch(negatedText, /text1\.js/, `negated class must not match text1.js, got: ${negatedText}`);
    }

    if (!POSIX) return;
    const grepResult = await executeInTier(grepTierPath(newTempDir('shims')), { pattern: 'Hello', output_mode: 'files', glob: 'text[0-9].js' });
    const grepText = messageOf(grepResult);
    assert.ok(
      (grepResult.ok && /text1\.js/.test(grepText)) || !grepResult.ok,
      `[grep-tier] bracket class known-positive must be found or fail typed, got ok=true: ${grepText}`,
    );
  });

  test('malformed brace and class grammar is a typed error, never a silent scan', { timeout: 15_000 }, async () => {
    const envPath = nodeTierPath();
    for (const bad of ['*.{ts', 'text1.js}', 'text[0-9.js', '{a,b{c,d}}}}']) {
      const result = await executeInTier(envPath, { pattern: 'Hello', output_mode: 'files', glob: bad });
      assert.ok(!result.ok, `malformed glob ${JSON.stringify(bad)} must be rejected, got ok=true: ${messageOf(result).slice(0, 200)}`);
      if (!result.ok) {
        assert.equal(result.errorCode, 'INVALID_TOOL_ARGUMENTS', `malformed glob ${JSON.stringify(bad)}: expected INVALID_TOOL_ARGUMENTS, got ${result.errorCode}`);
      }
    }
  });

  test('glob complexity bounds: oversized length and class body are typed errors', { timeout: 15_000 }, async () => {
    const envPath = nodeTierPath();
    const tooLong = 'a'.repeat(257);
    const result = await executeInTier(envPath, { pattern: 'Hello', output_mode: 'files', glob: tooLong });
    assert.ok(!result.ok, 'oversized glob must be rejected');
    if (!result.ok) assert.equal(result.errorCode, 'INVALID_TOOL_ARGUMENTS');

    const bigClass = `text[${'a'.repeat(200)}]b`;
    const classResult = await executeInTier(envPath, { pattern: 'Hello', output_mode: 'files', glob: bigClass });
    assert.ok(!classResult.ok, 'oversized class body must be rejected');
    if (!classResult.ok) assert.equal(classResult.errorCode, 'INVALID_TOOL_ARGUMENTS');
  });

  test('arguments are validated without coercion: hostile non-string args fail typed and fast', { timeout: 10_000 }, async () => {
    const envPath = nodeTierPath();
    const hostilePattern = { toString() { throw new Error('coercion hijack'); } };
    const start = performance.now();
    const result = await executeInTier(envPath, { pattern: hostilePattern });
    const elapsed = performance.now() - start;
    assert.ok(!result.ok, 'non-string pattern must be rejected');
    if (!result.ok) {
      assert.equal(result.errorCode, 'INVALID_TOOL_ARGUMENTS', `expected INVALID_TOOL_ARGUMENTS, got ${result.errorCode}`);
      assert.doesNotMatch(result.message, /coercion hijack/, 'error must not execute or leak hostile coercion output');
    }
    assert.ok(elapsed < 1_000, `validation must happen before any timer/dispatch, took ${Math.round(elapsed)}ms`);

    for (const badArgs of [{ pattern: 'x', glob: 42 }, { pattern: 'x', type: {} }, { pattern: 'x', path: 7 }]) {
      const r = await executeInTier(envPath, badArgs);
      assert.ok(!r.ok, `non-string ${Object.keys(badArgs).find(k => k !== 'pattern')} must be rejected, got ok=true`);
    }
  });

  test('completed searches leave no deadline timer behind', { timeout: 15_000 }, async () => {
    const envPath = nodeTierPath();
    const activeTimeouts = () =>
      (process as any)._getActiveHandles().filter((handle: any) => handle?.constructor?.name === 'Timeout').length;
    // Warm-up run initializes any lazily-created module-level timers.
    await executeInTier(envPath, { pattern: 'needle', output_mode: 'files', timeout_ms: 30_000 });
    const baseline = activeTimeouts();
    const result = await executeInTier(envPath, { pattern: 'needle', output_mode: 'files', timeout_ms: 30_000 });
    assert.ok(result.ok, `search must complete, got: ${messageOf(result).slice(0, 200)}`);
    const after = activeTimeouts();
    assert.ok(
      after <= baseline,
      `completed search must dispose its deadline timer (baseline ${baseline}, after ${after}) — a 30s budget leak pins the event loop`,
    );
  });
});
