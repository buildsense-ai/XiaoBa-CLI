import { describe, test, before, after, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { GrepTool } from '../src/tools/grep-tool';
import {
  GREP_DEFAULT_TIMEOUT_MS,
  resolveGrepSearchTimeoutMs,
} from '../src/tools/grep-search-policy';
import { ToolExecutionContext } from '../src/types/tool';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

const isWin32 = process.platform === 'win32';

function getContent(result: { ok: boolean; content: unknown }): string {
  assert.strictEqual(result.ok, true, `期望 ok=true，实际: ${JSON.stringify(result)}`);
  return result.content as string;
}

function getFailure(result: { ok: boolean; errorCode?: string; message?: string }): {
  ok: false;
  errorCode: string;
  message: string;
} {
  assert.strictEqual(result.ok, false, `期望 ok=false，实际: ${JSON.stringify(result)}`);
  return result as { ok: false; errorCode: string; message: string };
}

/** Deterministic fake backend dir: shadow rg/grep no matter where they live. */
function writeShim(binDir: string, name: string, lines: string[]): string {
  const shimPath = path.join(binDir, name);
  fs.writeFileSync(shimPath, ['#!/bin/sh', ...lines].join('\n'));
  fs.chmodSync(shimPath, 0o755);
  return shimPath;
}

function restrictedPath(binDir: string): string {
  return `${binDir}:/usr/bin:/bin`;
}

describe('GrepTool deadline runtime', () => {
  let grepTool: GrepTool;
  let testDir: string;
  let outsideDir: string;
  let fakeBin: string;
  let markerFile: string;
  let context: ToolExecutionContext;
  const savedPath = process.env.PATH;

  before(() => {
    if (isWin32) return;
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grep-deadline-fixture-'));
    fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'grep-deadline-bin-'));
    markerFile = path.join(testDir, '.grep-retry-marker');

    // ERE 固定件：BRE 把 + 当字面量，只有 -E 才能匹配 —— 复现 Threads-Scraper 假空。
    fs.writeFileSync(path.join(testDir, 'Threads-Scraper-2026.txt'), 'Threads-Scraper-42 session=alpha\n');
    fs.mkdirSync(path.join(testDir, 'notes'), { recursive: true });
    fs.writeFileSync(path.join(testDir, 'alpha.js'), 'function hello() {\n  console.log("hello world");\n}\n');
    fs.writeFileSync(path.join(testDir, 'notes', 'a.md'), 'hello from markdown\n');
    fs.writeFileSync(path.join(testDir, 'data.json'), '{"hello": "world"}\n');
    fs.mkdirSync(path.join(testDir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(testDir, '.git', 'config'), 'canaryGIT hello\n');
    // symlink 目标放在搜索根之外：根内若存在真实目录，则文件本就可达，无法检验 symlink 不扩界。
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grep-deadline-outside-'));
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'canarySYMLINK hello\n');
    fs.symlinkSync(outsideDir, path.join(testDir, 'linked'), 'dir');
    fs.writeFileSync(path.join(testDir, 'binary.bin'), Buffer.concat([Buffer.from('HELLO'), Buffer.from([0x00]), Buffer.from('WORLD')]));
    fs.writeFileSync(path.join(testDir, 'redos.txt'), 'a'.repeat(50_000));
  });

  after(() => {
    process.env.PATH = savedPath;
    for (const dir of [testDir, outsideDir, fakeBin]) {
      if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    process.env.PATH = savedPath;
    if (fs.existsSync(markerFile)) fs.rmSync(markerFile);
    // 每个用例独立的假后端目录，避免 shim 泄漏到其他用例。
    fs.rmSync(fakeBin, { recursive: true, force: true });
    fs.mkdirSync(fakeBin, { recursive: true });
    grepTool = new GrepTool();
    context = {
      workingDirectory: testDir,
      sessionId: 'grep-deadline-test',
      surface: 'cli',
    };
  });

  describe('共享截止时间与终态契约', () => {
    test('无 rg 时原生 grep 必须以 -E 匹配 ERE 固定件（Threads-Scraper 假空回归）', async () => {
      if (isWin32) return;
      writeShim(fakeBin, 'rg', ['exit 127']);
      process.env.PATH = restrictedPath(fakeBin);

      const result = await grepTool.execute(
        { pattern: 'Threads-Scraper-[0-9]+', output_mode: 'files' },
        context,
      );
      const text = getContent(result);
      assert.ok(text.includes('Threads-Scraper-2026.txt'), `应通过 grep -E 找到 ERE 固定件，实际: ${text}`);
    });

    test('无匹配成功后立即停止，不重试后续后端', async () => {
      if (isWin32) return;
      writeShim(fakeBin, 'rg', ['exit 1']);
      writeShim(fakeBin, 'grep', [`echo invoked > "${markerFile}"`, 'exit 127']);
      process.env.PATH = restrictedPath(fakeBin);

      const result = await grepTool.execute(
        { pattern: `UniqueNoMatch_${Date.now()}_${Math.random().toString(36).slice(2)}`, output_mode: 'files' },
        context,
      );
      const text = getContent(result);
      assert.ok(text.includes('未找到匹配项'), `应返回明确的无匹配结果，实际: ${text}`);
      assert.ok(!fs.existsSync(markerFile), 'rg 干净无匹配（exit 1）后不应再调用 grep');
    });

    test('截止时间跨后端共享：rg 烧掉 600ms 后 grep 在同一预算内被打断', async () => {
      if (isWin32) return;
      writeShim(fakeBin, 'rg', ['sleep 0.6', 'exit 127']);
      writeShim(fakeBin, 'grep', ['sleep 30', `echo invoked > "${markerFile}"`, 'exit 0']);
      process.env.PATH = restrictedPath(fakeBin);

      const startedAt = Date.now();
      const result = await grepTool.execute(
        { pattern: 'hello', output_mode: 'files', timeout_ms: 1200 },
        context,
      );
      const elapsed = Date.now() - startedAt;
      const failure = getFailure(result);
      assert.strictEqual(failure.errorCode, 'SEARCH_TIMEOUT');
      assert.match(failure.message, /超时/);
      assert.ok(elapsed < 2000, `绝对截止时间应约 1200ms（按后端各自计时会 ≥1800ms），实际 ${elapsed}ms`);
      assert.ok(elapsed >= 1100, `不应早于预算完成，实际 ${elapsed}ms`);
      assert.ok(!fs.existsSync(markerFile), '超时后不应启动或写入后续后端');
    });

    test('超时是终态：不重试、不返回假空', async () => {
      if (isWin32) return;
      writeShim(fakeBin, 'rg', ['sleep 30']);
      writeShim(fakeBin, 'grep', [`echo invoked > "${markerFile}"`, 'exit 0']);
      process.env.PATH = restrictedPath(fakeBin);

      const startedAt = Date.now();
      const result = await grepTool.execute(
        { pattern: 'hello', output_mode: 'files', timeout_ms: 400 },
        context,
      );
      const failure = getFailure(result);
      assert.strictEqual(failure.errorCode, 'SEARCH_TIMEOUT');
      assert.ok(!failure.message.includes('未找到匹配项'), '超时绝不伪装成无匹配');
      assert.ok(Date.now() - startedAt < 2500, '超时应按时触发');
      assert.ok(!fs.existsSync(markerFile), '超时后不应重试 grep');
    });

    test('取消是终态且与超时区分：不重试', async () => {
      if (isWin32) return;
      writeShim(fakeBin, 'rg', ['sleep 30']);
      writeShim(fakeBin, 'grep', [`echo invoked > "${markerFile}"`, 'exit 0']);
      process.env.PATH = restrictedPath(fakeBin);

      const controller = new AbortController();
      setTimeout(() => controller.abort(), 120);
      const startedAt = Date.now();
      const result = await grepTool.execute(
        { pattern: 'hello', output_mode: 'files', timeout_ms: 30000 },
        { ...context, abortSignal: controller.signal },
      );
      const failure = getFailure(result);
      assert.strictEqual(failure.errorCode, 'SEARCH_CANCELLED');
      assert.match(failure.message, /搜索已取消/);
      assert.ok(Date.now() - startedAt < 2500, '取消后应立即停止');
      assert.ok(!fs.existsSync(markerFile), '取消后不应重试 grep');
    });

    test('结果溢出是终态：不重试、不返回部分内容', async () => {
      if (isWin32) return;
      writeShim(fakeBin, 'rg', ['head -c 12000000 /dev/zero | tr "\\\\000" "a"']);
      writeShim(fakeBin, 'grep', [`echo invoked > "${markerFile}"`, 'exit 0']);
      process.env.PATH = restrictedPath(fakeBin);

      const startedAt = Date.now();
      const result = await grepTool.execute(
        { pattern: 'hello', output_mode: 'content', timeout_ms: 30000 },
        context,
      );
      const failure = getFailure(result);
      assert.strictEqual(failure.errorCode, 'SEARCH_RESULT_OVERFLOW');
      assert.ok(Date.now() - startedAt < 8000, '溢出应尽快终止');
      assert.ok(!fs.existsSync(markerFile), '溢出后不应重试 grep');
    });

    test('timeout_ms 下界 100 可用且按时触发', async () => {
      if (isWin32) return;
      writeShim(fakeBin, 'rg', ['sleep 30']);
      process.env.PATH = restrictedPath(fakeBin);

      const startedAt = Date.now();
      const result = await grepTool.execute(
        { pattern: 'hello', output_mode: 'files', timeout_ms: 100 },
        context,
      );
      const failure = getFailure(result);
      assert.strictEqual(failure.errorCode, 'SEARCH_TIMEOUT');
      assert.ok(Date.now() - startedAt < 2000);
    });

    test('timeout_ms 非法值返回 INVALID_TOOL_ARGUMENTS 而不是静默放宽', async () => {
      for (const invalid of [50_000, 99, 0, -1, '1000', 100.5, null]) {
        const result = await grepTool.execute(
          { pattern: 'hello', timeout_ms: invalid },
          context,
        );
        const failure = getFailure(result);
        assert.strictEqual(failure.errorCode, 'INVALID_TOOL_ARGUMENTS', `timeout_ms=${JSON.stringify(invalid)} 应被拒绝`);
      }
    });

    test('默认预算来自共享策略（15000ms）', () => {
      assert.strictEqual(resolveGrepSearchTimeoutMs(), GREP_DEFAULT_TIMEOUT_MS);
      assert.strictEqual(resolveGrepSearchTimeoutMs(), 15_000);
    });
  });

  describe('过滤正确性', () => {
    test('glob 支持花括号并在扫描前生效', async () => {
      const result = await grepTool.execute(
        { pattern: 'hello', glob: '*.{js,md}', output_mode: 'files' },
        context,
      );
      const text = getContent(result);
      assert.ok(text.includes('alpha.js'), `应包含 alpha.js，实际: ${text}`);
      assert.ok(text.includes('a.md'), '应包含 notes/a.md');
      assert.ok(!text.includes('data.json'), '不应包含 data.json');
      assert.ok(!text.includes('Threads-Scraper'), '不应包含未过滤文件');
    });

    test('type 过滤生效；未知类型可见报错，绝不静默放宽或假空', async () => {
      const filtered = await grepTool.execute(
        { pattern: 'hello', type: 'json', output_mode: 'files' },
        context,
      );
      const text = getContent(filtered);
      assert.ok(text.includes('data.json'), `应包含 data.json，实际: ${text}`);
      assert.ok(!text.includes('alpha.js'), '不应包含非 json 文件');

      const unsupported = await grepTool.execute(
        { pattern: 'hello', type: 'definitely-not-a-real-type', output_mode: 'files' },
        context,
      );
      const failure = getFailure(unsupported);
      assert.strictEqual(failure.errorCode, 'UNSUPPORTED_FILE_TYPE');
      assert.match(failure.message, /definitely-not-a-real-type/);
      assert.ok(!failure.message.includes('未找到匹配项'), '不支持类型绝不伪装成无匹配');
    });

    test('二进制文件不崩溃、不悬挂', async () => {
      const result = await grepTool.execute(
        { pattern: 'HELLO', output_mode: 'content', timeout_ms: 5000 },
        context,
      );
      assert.strictEqual(result.ok, true);
      assert.ok(typeof result.content === 'string');
    });

    test('FIFO 特殊文件不产生假空（匹配 或 类型化超时）', async () => {
      if (isWin32) return;
      const fifoPath = path.join(testDir, 'pipe');
      let fifoAvailable = true;
      try {
        execSync(`mkfifo "${fifoPath}"`, { stdio: 'pipe' });
      } catch {
        fifoAvailable = false;
      }
      if (!fifoAvailable) return;
      writeShim(fakeBin, 'rg', ['exit 127']);
      process.env.PATH = restrictedPath(fakeBin);

      try {
        const startedAt = Date.now();
        const result = await grepTool.execute(
          { pattern: 'Threads-Scraper-[0-9]+', output_mode: 'files', timeout_ms: 1500 },
          context,
        );
        assert.ok(Date.now() - startedAt < 5000, '必须在截止时间内结束，而不是永久等待 FIFO');
        if (result.ok) {
          assert.ok(String(result.content).includes('Threads-Scraper-2026.txt'), String(result.content));
        } else {
          assert.strictEqual((result as any).errorCode, 'SEARCH_TIMEOUT', '只能要么匹配要么类型化超时，绝不能假空');
          assert.ok(!(result as any).message.includes('未找到匹配项'));
        }
      } finally {
        fs.rmSync(fifoPath, { force: true });
      }
    });
  });

  describe('Node 后端隔离', () => {
    test('灾难性正则在 worker 中执行：deadline 到点终止且主线程保持响应', async () => {
      if (isWin32) return;
      writeShim(fakeBin, 'rg', ['exit 127']);
      writeShim(fakeBin, 'grep', ['exit 127']);
      process.env.PATH = restrictedPath(fakeBin);

      let ticks = 0;
      const ticker = setInterval(() => { ticks += 1; }, 10);
      const startedAt = Date.now();
      try {
        const result = await grepTool.execute(
          { pattern: '(a+)+b', output_mode: 'files', timeout_ms: 600 },
          context,
        );
        const failure = getFailure(result);
        assert.strictEqual(failure.errorCode, 'SEARCH_TIMEOUT');
        assert.ok(Date.now() - startedAt < 3000, `ReDoS 必须被 deadline 截断，实际 ${Date.now() - startedAt}ms`);
        assert.ok(!failure.message.includes('未找到匹配项'), 'ReDoS 截断绝不伪装成无匹配');
      } finally {
        clearInterval(ticker);
      }
      assert.ok(ticks > 20, `worker 隔离期间主线程事件循环应保持响应，实际 tick=${ticks}`);
    });

    test('Node 后端在读取文件前应用 glob 过滤', async () => {
      if (isWin32) return;
      const originalReadFile = fs.promises.readFile;
      const readPaths: string[] = [];
      (fs.promises as any).readFile = (...callArgs: any[]) => {
        readPaths.push(String(callArgs[0]));
        return originalReadFile.apply(fs.promises, callArgs as any);
      };
      try {
        const tool = new GrepTool();
        const result = await (tool as any).executeWithNodeJS(
          { pattern: 'hello', glob: '*.md', output_mode: 'files' },
          testDir,
          context,
          '.',
        );
        assert.strictEqual(result.kind, 'matches');
        assert.ok(readPaths.some(p => p.endsWith('a.md')), '应读取 .md 文件');
        assert.ok(!readPaths.some(p => p.endsWith('alpha.js')), 'glob 不匹配的文件不应被读取');
        assert.ok(!readPaths.some(p => p.includes('data.json')), 'glob 不匹配的文件不应被读取');
      } finally {
        (fs.promises as any).readFile = originalReadFile;
      }
    });

    test('Node 后端 count 模式报告真实计数并遵守 VCS/符号链接边界', async () => {
      if (isWin32) return;
      const tool = new GrepTool();
      const result = await (tool as any).executeWithNodeJS(
        { pattern: 'hello', output_mode: 'count' },
        testDir,
        context,
        '.',
      );
      assert.strictEqual(result.kind, 'matches');
      const stdout: string = result.stdout;
      assert.ok(!stdout.includes('.git'), 'VCS 目录必须被排除');
      assert.ok(!stdout.includes('linked'), '符号链接目录不得扩界');
      assert.ok(!stdout.includes('secret.txt'), '搜索根外的 symlink 目标不得泄漏');
      const alphaLine = stdout.split('\n').find(line => line.includes('alpha.js'));
      assert.ok(alphaLine, `应包含 alpha.js 的计数行，实际: ${stdout}`);
      assert.ok(alphaLine.endsWith(':2'), `alpha.js 有两处 hello，应报告真实计数 2，实际: ${alphaLine}`);
    });
  });

  describe('范围与权限边界', () => {
    test('VCS 目录、符号链接目录不进入结果', async () => {
      const result = await grepTool.execute(
        { pattern: 'canary', output_mode: 'files' },
        context,
      );
      const text = getContent(result);
      assert.ok(!text.includes('.git'), 'VCS 目录必须被排除');
      assert.ok(!text.includes('linked'), '符号链接目录不得扩界');
      assert.ok(!text.includes('secret.txt'), '搜索根外的 symlink 目标不得泄漏');
    });

    test('无权限文件按权限语义跳过，搜索正常完成', async () => {
      if (isWin32) return;
      if (typeof process.getuid === 'function' && process.getuid() === 0) return;
      const locked = path.join(testDir, 'locked.txt');
      fs.writeFileSync(locked, 'canaryPERM hello\n');
      fs.chmodSync(locked, 0o000);
      try {
        const result = await grepTool.execute(
          { pattern: 'canaryPERM', output_mode: 'files', timeout_ms: 5000 },
          context,
        );
        // 不论后端是跳过（无匹配）还是报错，都不能悬挂或崩溃成空结果假象。
        if (result.ok) {
          assert.ok(typeof result.content === 'string');
        } else {
          assert.ok(!String(result.message).includes('未找到匹配项'));
        }
      } finally {
        fs.chmodSync(locked, 0o644);
      }
    });
  });

  describe('后端计时 seam', () => {
    test('backend_timing 只输出枚举与数字，不含路径/模式/内容', async () => {
      const result = await grepTool.execute(
        { pattern: 'hello', output_mode: 'files', backend_timing: true },
        context,
      );
      const text = getContent(result);
      const marker = text.indexOf('[backend timing]');
      assert.ok(marker > 0, '应包含 backend timing 段');
      const timingBlock = text.slice(marker);
      const lines = timingBlock.split('\n').slice(1);
      assert.ok(lines.length >= 2, '至少一条后端记录与 total');
      for (const line of lines) {
        const isBackendLine = /^(ripgrep|grep|node): \d+ms \([a-z_]+\)$/.test(line);
        const isTotalLine = /^total: \d+ms$/.test(line);
        assert.ok(isBackendLine || isTotalLine, `timing 行只能是枚举+数字，实际: ${line}`);
        assert.ok(!line.includes(testDir), 'timing 不得包含路径');
        assert.ok(!line.includes('hello'), 'timing 不得包含模式或内容');
      }
      const okLine = lines.find(l => l.startsWith('ripgrep:'));
      assert.ok(okLine && /\((ok|no_match)\)/.test(okLine), `ripgrep 后端应成功完成，实际: ${okLine}`);
    });

    test('默认不输出计时段', async () => {
      const result = await grepTool.execute(
        { pattern: 'hello', output_mode: 'files' },
        context,
      );
      const text = getContent(result);
      assert.ok(!text.includes('[backend timing]'));
    });
  });
});
