/**
 * tool-manager 核心测试：验证 ToolExecutionResult 结构统一处理
 */
import { afterEach, beforeEach, describe, test, mock } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as http from 'http';
import { ToolManager } from '../src/tools/tool-manager';
import type { ExecutionScope } from '../src/types/session-identity';

const ONE_PIXEL_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

describe('ToolManager - ToolExecutionResult 统一处理', () => {
  let manager: ToolManager;
  let testRoot: string;
  let previousUserDataDir: string | undefined;

  beforeEach(() => {
    previousUserDataDir = process.env.XIAOBA_USER_DATA_DIR;
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-result-'));
    process.env.XIAOBA_USER_DATA_DIR = testRoot;
    manager = new ToolManager(testRoot);
  });

  afterEach(() => {
    if (previousUserDataDir === undefined) delete process.env.XIAOBA_USER_DATA_DIR;
    else process.env.XIAOBA_USER_DATA_DIR = previousUserDataDir;
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  // ─── 成功路径 ───────────────────────────────────────────────

  test('write_file 成功返回 ok=true', async () => {
    const result = await manager.executeTool(
      { id: 't1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ file_path: 'ok.txt', content: 'hello' }) } },
      [],
    );
    assert.strictEqual(result.ok, true);
    assert.ok(result.content?.includes('成功写入') || result.content?.includes('成功创建'));
    assert.strictEqual(result.errorCode, undefined);
  });

  test('read_file 成功返回 ok=true', async () => {
    const filePath = path.join(testRoot, 'read_ok.txt');
    fs.writeFileSync(filePath, 'line1\nline2\nline3');
    const result = await manager.executeTool(
      { id: 't2', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ file_path: filePath }) } },
      [],
    );
    assert.strictEqual(result.ok, true);
    assert.ok(result.content?.includes('read_ok.txt'));
    assert.strictEqual(result.errorCode, undefined);
  });

  test('edit_file 成功返回 ok=true', async () => {
    const filePath = path.join(testRoot, 'edit_ok.txt');
    fs.writeFileSync(filePath, 'hello world');
    const result = await manager.executeTool(
      { id: 't3', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ file_path: filePath, old_string: 'world', new_string: 'Albert' }) } },
      [],
    );
    assert.strictEqual(result.ok, true);
    assert.ok(result.content?.includes('成功编辑'));
    assert.strictEqual(result.errorCode, undefined);
  });

  test('glob 成功返回 ok=true', async () => {
    fs.writeFileSync(path.join(testRoot, 'a.txt'), '');
    fs.writeFileSync(path.join(testRoot, 'b.txt'), '');
    const result = await manager.executeTool(
      { id: 't4', type: 'function', function: { name: 'glob', arguments: JSON.stringify({ pattern: '*.txt' }) } },
      [],
    );
    assert.strictEqual(result.ok, true);
    assert.ok(String(result.content).includes('a.txt'));
    assert.ok(String(result.content).includes('b.txt'));
    assert.strictEqual(result.errorCode, undefined);
  });

  test('glob returns absolute filenames when searching an absolute path', async () => {
    const filePath = path.join(testRoot, 'absolute-result.txt');
    fs.writeFileSync(filePath, '');

    const result = await manager.executeTool(
      { id: 't4_abs', type: 'function', function: { name: 'glob', arguments: JSON.stringify({ pattern: '*.txt', path: testRoot }) } },
      [],
    );

    assert.strictEqual(result.ok, true);
    assert.ok(String(result.content).includes(filePath));
    assert.strictEqual(result.errorCode, undefined);
  });

  test('glob can include directories when requested', async () => {
    fs.mkdirSync(path.join(testRoot, 'matched-dir'));
    fs.writeFileSync(path.join(testRoot, 'matched-file.txt'), '');

    const defaultResult = await manager.executeTool(
      { id: 't4_dir_default', type: 'function', function: { name: 'glob', arguments: JSON.stringify({ pattern: '*' }) } },
      [],
    );
    assert.strictEqual(defaultResult.ok, true);
    assert.ok(!String(defaultResult.content).includes('matched-dir'));
    assert.ok(String(defaultResult.content).includes('matched-file.txt'));

    const withDirectories = await manager.executeTool(
      { id: 't4_dir_include', type: 'function', function: { name: 'glob', arguments: JSON.stringify({ pattern: '*', include_directories: true }) } },
      [],
    );
    assert.strictEqual(withDirectories.ok, true);
    assert.ok(String(withDirectories.content).includes('matched-dir'));
    assert.ok(String(withDirectories.content).includes('matched-file.txt'));
    assert.strictEqual(withDirectories.errorCode, undefined);
  });

  test('read_file uses reader proxy path for images when primary model is text-only', async () => {
    const previousConfigPath = process.env.XIAOBA_CONFIG_PATH;
    const previousModel = process.env.GAUZ_LLM_MODEL;
    const previousApiKey = process.env.CATSCOMPANY_API_KEY;
    const previousReaderApiKey = process.env.READER_PROXY_API_KEY;
    process.env.XIAOBA_CONFIG_PATH = path.join(testRoot, 'missing-config.json');
    process.env.GAUZ_LLM_MODEL = 'gpt-3.5-turbo';
    delete process.env.CATSCOMPANY_API_KEY;
    delete process.env.READER_PROXY_API_KEY;

    try {
      const filePath = path.join(testRoot, 'image.png');
      fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      const result = await manager.executeTool(
        { id: 't2_img', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ file_path: filePath }) } },
        [{ role: 'user', content: '帮我看看图里有什么' }],
      );

      assert.strictEqual(result.ok, true);
      assert.ok(String(result.content).includes('当前主模型不能直接读取图片内容'));
      assert.ok(String(result.content).includes('当前 CatsCo 登录或机器人绑定没有提供有效认证'));
      assert.ok(String(result.content).includes('排查信息'));
      assert.strictEqual(result.errorCode, undefined);
    } finally {
      if (previousConfigPath === undefined) delete process.env.XIAOBA_CONFIG_PATH;
      else process.env.XIAOBA_CONFIG_PATH = previousConfigPath;
      if (previousModel === undefined) delete process.env.GAUZ_LLM_MODEL;
      else process.env.GAUZ_LLM_MODEL = previousModel;
      if (previousApiKey === undefined) delete process.env.CATSCOMPANY_API_KEY;
      else process.env.CATSCOMPANY_API_KEY = previousApiKey;
      if (previousReaderApiKey === undefined) delete process.env.READER_PROXY_API_KEY;
      else process.env.READER_PROXY_API_KEY = previousReaderApiKey;
    }
  });

  test('read_file returns a direct image block for MiniMax M3 relay model', async () => {
    const previousConfigPath = process.env.XIAOBA_CONFIG_PATH;
    const previousProvider = process.env.GAUZ_LLM_PROVIDER;
    const previousApiBase = process.env.GAUZ_LLM_API_BASE;
    const previousModel = process.env.GAUZ_LLM_MODEL;
    process.env.XIAOBA_CONFIG_PATH = path.join(testRoot, 'missing-config.json');
    process.env.GAUZ_LLM_PROVIDER = 'anthropic';
    process.env.GAUZ_LLM_API_BASE = 'https://relay.catsco.cc/anthropic';
    process.env.GAUZ_LLM_MODEL = 'MiniMax-M3';

    try {
      const filePath = path.join(testRoot, 'm3-image.png');
      fs.writeFileSync(filePath, Buffer.from(ONE_PIXEL_PNG_BASE64, 'base64'));

      const result = await manager.executeTool(
        { id: 't2_m3_img', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ file_path: filePath }) } },
        [{ role: 'user', content: '帮我看看图里有什么' }],
      );

      assert.strictEqual(result.ok, true);
      const content = result.content as any;
      assert.strictEqual(content._imageForNewMessage, true);
      assert.strictEqual(content.filePath, filePath);
      assert.strictEqual(content.imageBlock.type, 'image');
      assert.strictEqual(content.imageBlock.source.type, 'base64');
      assert.strictEqual(content.imageBlock.source.media_type, 'image/jpeg');
      assert.ok(content.imageBlock.source.data.length > 0);
      assert.strictEqual(result.errorCode, undefined);
    } finally {
      if (previousConfigPath === undefined) delete process.env.XIAOBA_CONFIG_PATH;
      else process.env.XIAOBA_CONFIG_PATH = previousConfigPath;
      if (previousProvider === undefined) delete process.env.GAUZ_LLM_PROVIDER;
      else process.env.GAUZ_LLM_PROVIDER = previousProvider;
      if (previousApiBase === undefined) delete process.env.GAUZ_LLM_API_BASE;
      else process.env.GAUZ_LLM_API_BASE = previousApiBase;
      if (previousModel === undefined) delete process.env.GAUZ_LLM_MODEL;
      else process.env.GAUZ_LLM_MODEL = previousModel;
    }
  });

  test('read_file falls back to reader proxy when MiniMax M3 image block creation fails', async () => {
    const previousConfigPath = process.env.XIAOBA_CONFIG_PATH;
    const previousProvider = process.env.GAUZ_LLM_PROVIDER;
    const previousApiBase = process.env.GAUZ_LLM_API_BASE;
    const previousModel = process.env.GAUZ_LLM_MODEL;
    const previousReaderUrl = process.env.CATSCOMPANY_READER_API_URL;
    const previousApiKey = process.env.CATSCOMPANY_API_KEY;
    const consoleError = mock.method(console, 'error', () => {});
    let requestCount = 0;
    let observedRequest:
      | { method?: string; url?: string; authorization?: string; body: string }
      | undefined;

    const readerServer = http.createServer((req, res) => {
      requestCount += 1;
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        observedRequest = {
          method: req.method,
          url: req.url,
          authorization: Array.isArray(req.headers.authorization)
            ? req.headers.authorization.join(',')
            : req.headers.authorization,
          body: Buffer.concat(chunks).toString('utf8'),
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ analysis: 'fallback proxy analysis' }));
      });
    });

    let serverListening = false;

    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        readerServer.once('error', onError);
        readerServer.listen(0, '127.0.0.1', () => {
          readerServer.off('error', onError);
          serverListening = true;
          resolve();
        });
      });
      const address = readerServer.address();
      if (!address || typeof address === 'string') throw new Error('reader server did not bind');

      process.env.XIAOBA_CONFIG_PATH = path.join(testRoot, 'missing-config.json');
      process.env.GAUZ_LLM_PROVIDER = 'anthropic';
      process.env.GAUZ_LLM_API_BASE = 'https://relay.catsco.cc/anthropic';
      process.env.GAUZ_LLM_MODEL = 'MiniMax-M3';
      process.env.CATSCOMPANY_READER_API_URL = `http://127.0.0.1:${address.port}`;
      process.env.CATSCOMPANY_API_KEY = 'cats-reader-test-key';

      const filePath = path.join(testRoot, 'broken-m3-image.png');
      fs.writeFileSync(filePath, Buffer.from('not a valid image'));

      const result = await manager.executeTool(
        { id: 't2_m3_img_fallback', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ file_path: filePath }) } },
        [{ role: 'user', content: '这张图里有什么' }],
      );

      assert.strictEqual(result.ok, true);
      assert.strictEqual(requestCount, 1);
      assert.deepStrictEqual(
        {
          method: observedRequest?.method,
          url: observedRequest?.url,
          authorization: observedRequest?.authorization,
        },
        {
          method: 'POST',
          url: '/analyze',
          authorization: 'ApiKey cats-reader-test-key',
        },
      );
      assert.ok(observedRequest?.body.includes('name="prompt"'));
      assert.ok(observedRequest?.body.includes('这张图里有什么'));
      assert.strictEqual(typeof result.content, 'string');
      assert.ok(String(result.content).includes('主模型图片块生成失败，已自动改用 Cats reader proxy 解析'));
      assert.ok(String(result.content).includes('fallback proxy analysis'));
      assert.strictEqual(result.errorCode, undefined);
    } finally {
      if (serverListening) {
        await new Promise<void>(resolve => readerServer.close(() => resolve()));
      }
      if (previousConfigPath === undefined) delete process.env.XIAOBA_CONFIG_PATH;
      else process.env.XIAOBA_CONFIG_PATH = previousConfigPath;
      if (previousProvider === undefined) delete process.env.GAUZ_LLM_PROVIDER;
      else process.env.GAUZ_LLM_PROVIDER = previousProvider;
      if (previousApiBase === undefined) delete process.env.GAUZ_LLM_API_BASE;
      else process.env.GAUZ_LLM_API_BASE = previousApiBase;
      if (previousModel === undefined) delete process.env.GAUZ_LLM_MODEL;
      else process.env.GAUZ_LLM_MODEL = previousModel;
      if (previousReaderUrl === undefined) delete process.env.CATSCOMPANY_READER_API_URL;
      else process.env.CATSCOMPANY_READER_API_URL = previousReaderUrl;
      if (previousApiKey === undefined) delete process.env.CATSCOMPANY_API_KEY;
      else process.env.CATSCOMPANY_API_KEY = previousApiKey;
      consoleError.mock.restore();
    }
  });

  test('grep 成功返回 ok=true', async () => {
    const filePath = path.join(testRoot, 'grep_ok.txt');
    fs.writeFileSync(filePath, 'match line here');
    const result = await manager.executeTool(
      { id: 't5', type: 'function', function: { name: 'grep', arguments: JSON.stringify({ pattern: 'match', path: testRoot }) } },
      [],
    );
    assert.strictEqual(result.ok, true);
    assert.ok(result.content?.includes('找到'));
    assert.strictEqual(result.errorCode, undefined);
  });

  // ─── 失败路径 ───────────────────────────────────────────────

  test('read_file 文件不存在返回 ok=false + FILE_NOT_FOUND', async () => {
    const result = await manager.executeTool(
      { id: 't7', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ file_path: '/nope/not/exist.txt' }) } },
      [],
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'FILE_NOT_FOUND');
    assert.ok(result.content?.includes('文件不存在'));
  });

  test('edit_file 文件不存在返回 ok=false + FILE_NOT_FOUND', async () => {
    const result = await manager.executeTool(
      { id: 't8', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ file_path: '/nope/not/exist.txt', old_string: 'a', new_string: 'b' }) } },
      [],
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'FILE_NOT_FOUND');
    assert.ok(result.content?.includes('文件不存在'));
  });

  test('edit_file old_string 不存在返回 ok=false', async () => {
    const filePath = path.join(testRoot, 'no_match.txt');
    fs.writeFileSync(filePath, 'original content');
    const result = await manager.executeTool(
      { id: 't9', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ file_path: filePath, old_string: 'not found string', new_string: 'x' }) } },
      [],
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'TOOL_EXECUTION_ERROR');
    assert.ok(result.content?.includes('未找到'));
  });

  test('edit_file replace_all=false 但匹配多个返回 ok=false', async () => {
    const filePath = path.join(testRoot, 'multi_match.txt');
    fs.writeFileSync(filePath, 'foo bar foo baz');
    const result = await manager.executeTool(
      { id: 't10', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ file_path: filePath, old_string: 'foo', new_string: 'baz', replace_all: false }) } },
      [],
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'TOOL_EXECUTION_ERROR');
    assert.ok(result.content?.includes('2 个匹配项'));
  });

  test('glob 目录不存在返回 ok=false', async () => {
    const result = await manager.executeTool(
      { id: 't11', type: 'function', function: { name: 'glob', arguments: JSON.stringify({ pattern: '*.txt', path: '/nope/not/here' }) } },
      [],
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'FILE_NOT_FOUND');
  });

  test('tool 不存在返回 ok=false + TOOL_NOT_FOUND', async () => {
    const result = await manager.executeTool(
      { id: 't12', type: 'function', function: { name: 'nonexistent_tool', arguments: '{}' } },
      [],
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'TOOL_NOT_FOUND');
  });

  test('参数 JSON 无效返回 ok=false + INVALID_TOOL_ARGUMENTS', async () => {
    const result = await manager.executeTool(
      { id: 't13', type: 'function', function: { name: 'write_file', arguments: '{bad json' } },
      [],
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'INVALID_TOOL_ARGUMENTS');
  });

  test('spawn_subagent 参数缺失返回 ok=false', async () => {
    const result = await manager.executeTool(
      { id: 't14', type: 'function', function: { name: 'spawn_subagent', arguments: JSON.stringify({}) } },
      [],
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'INVALID_TOOL_ARGUMENTS');
    assert.ok(result.content?.includes('必填参数'));
  });

  test('stop_subagent 参数缺失返回 ok=false', async () => {
    const result = await manager.executeTool(
      { id: 't15', type: 'function', function: { name: 'stop_subagent', arguments: JSON.stringify({}) } },
      [],
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'INVALID_TOOL_ARGUMENTS');
  });

  test('resume_subagent 参数缺失返回 ok=false', async () => {
    const result = await manager.executeTool(
      { id: 't16', type: 'function', function: { name: 'resume_subagent', arguments: JSON.stringify({ subagent_id: 'sub-1' }) } },
      [],
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'INVALID_TOOL_ARGUMENTS');
  });

  test('check_subagent 不存在的 ID 返回 ok=false', async () => {
    const result = await manager.executeTool(
      { id: 't17', type: 'function', function: { name: 'check_subagent', arguments: JSON.stringify({ subagent_id: 'sub-does-not-exist' }) } },
      [],
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'TOOL_NOT_FOUND');
  });

  test('stop_subagent 不存在的 ID 返回 ok=false', async () => {
    const result = await manager.executeTool(
      { id: 't18', type: 'function', function: { name: 'stop_subagent', arguments: JSON.stringify({ subagent_id: 'sub-does-not-exist' }) } },
      [],
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'TOOL_NOT_FOUND');
  });

  // ─── 别名兼容 ───────────────────────────────────────────────

  test('Bash 别名映射到 execute_shell 成功', async () => {
    const result = await manager.executeTool(
      { id: 't19', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: 'echo hello' }) } },
      [],
    );
    assert.strictEqual(result.ok, true);
    assert.ok(result.content?.includes('hello'));
  });

  test('context overrides do not clear an existing AbortSignal with undefined', async () => {
    const controller = new AbortController();
    const scopedManager = new ToolManager(testRoot, { abortSignal: controller.signal }, {
      enabledToolNames: [],
    });
    let capturedSignal: AbortSignal | undefined;
    scopedManager.registerTool({
      definition: {
        name: 'capture_signal',
        description: 'capture signal',
        parameters: { type: 'object', properties: {} },
      },
      async execute(_args, context) {
        capturedSignal = context.abortSignal;
        return { ok: true, content: 'ok' };
      },
    });

    const result = await scopedManager.executeTool(
      { id: 't19_context_merge', type: 'function', function: { name: 'capture_signal', arguments: '{}' } },
      [],
      { abortSignal: undefined },
    );

    assert.strictEqual(result.ok, true);
    assert.strictEqual(capturedSignal, controller.signal);
  });

  test('context overrides do not clear an existing executionScope with undefined', async () => {
    const executionScope: ExecutionScope = {
      source: 'catscompany',
      sessionKey: 'cc_user:usr7',
      topicId: 'p2p_7_43',
      topicType: 'p2p',
      actorUserId: 'usr7',
      identityTrust: 'server_canonical',
      isTrusted: true,
    };
    const scopedManager = new ToolManager(testRoot, { executionScope }, {
      enabledToolNames: [],
    });
    let capturedScope: ExecutionScope | undefined;
    scopedManager.registerTool({
      definition: {
        name: 'capture_scope',
        description: 'capture scope',
        parameters: { type: 'object', properties: {} },
      },
      async execute(_args, context) {
        capturedScope = context.executionScope;
        return { ok: true, content: 'ok' };
      },
    });

    const result = await scopedManager.executeTool(
      { id: 't19_scope_merge', type: 'function', function: { name: 'capture_scope', arguments: '{}' } },
      [],
      { executionScope: undefined },
    );

    assert.strictEqual(result.ok, true);
    assert.strictEqual(capturedScope, executionScope);
  });

  test('Write 别名映射到 write_file 成功', async () => {
    const result = await manager.executeTool(
      { id: 't20', type: 'function', function: { name: 'Write', arguments: JSON.stringify({ file_path: 'alias.txt', content: 'via alias' }) } },
      [],
    );
    assert.strictEqual(result.ok, true);
    assert.ok(result.content?.includes('成功'));
  });
});
