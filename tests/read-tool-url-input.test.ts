/**
 * read_file 的 URL 输入行为。
 *
 * 单独成文件：URL 下载路径与本地路径读取互不影响，而原 read-tool 测试文件
 * 里的 PDF 用例很慢（要起 provider/reader 假服务器），混在一起会让这组
 * 快速用例被拖到超时。
 */
import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as http from 'http';
import { MAX_URL_DOWNLOAD_BYTES, ReadTool, isHttpUrl } from '../src/tools/read-tool';
import { ToolExecutionContext } from '../src/types/tool';

describe('ReadTool - URL input', () => {
  let tool: ReadTool;
  let testRoot: string;
  let context: ToolExecutionContext;
  let previousUserDataDir: string | undefined;
  let server: http.Server | undefined;
  let baseUrl = '';

  beforeEach(async () => {
    previousUserDataDir = process.env.XIAOBA_USER_DATA_DIR;
    tool = new ReadTool();
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'read-tool-url-'));
    process.env.XIAOBA_USER_DATA_DIR = testRoot;
    context = { workingDirectory: testRoot, conversationHistory: [] };
    baseUrl = '';
  });

  afterEach(async () => {
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>(resolve => server!.close(() => resolve()));
      server = undefined;
    }
    if (previousUserDataDir === undefined) delete process.env.XIAOBA_USER_DATA_DIR;
    else process.env.XIAOBA_USER_DATA_DIR = previousUserDataDir;
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  /** Starts a throwaway HTTP server whose handler decides every response. */
  async function startServer(
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  ): Promise<string> {
    server = http.createServer(handler);
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    return `http://127.0.0.1:${address.port}`;
  }

  test('isHttpUrl recognises http(s) and rejects everything else', () => {
    assert.strictEqual(isHttpUrl('https://example.com/a.txt'), true);
    assert.strictEqual(isHttpUrl('HTTP://example.com/a.txt'), true);
    assert.strictEqual(isHttpUrl('  https://example.com/a.txt  '), true);
    // A local path must keep going down the old route.
    assert.strictEqual(isHttpUrl('/tmp/a.txt'), false);
    assert.strictEqual(isHttpUrl('./a.txt'), false);
    assert.strictEqual(isHttpUrl('ftp://example.com/a.txt'), false);
    assert.strictEqual(isHttpUrl('file:///tmp/a.txt'), false);
    assert.strictEqual(isHttpUrl(''), false);
  });

  test('读取 http URL：先下载再按本地文件读取', async () => {
    const root = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('远程第一行\n远程第二行\n');
    });

    const result = await tool.execute({ file_path: `${root}/notes.txt` }, context);

    assert.strictEqual(result.ok, true, JSON.stringify(result));
    const content = result.content as string;
    assert.ok(content.includes('远程第一行'));
    assert.ok(content.includes('远程第二行'));
    // The model is told the original URL, not only the cache path.
    assert.ok(content.includes(`${root}/notes.txt`));
  });

  test('下载后按扩展名分派：URL 指向 .ipynb 走 notebook 读取', async () => {
    const notebook = JSON.stringify({ cells: [], nbformat: 4, nbformat_minor: 5, metadata: {} });
    const root = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(notebook);
    });

    const result = await tool.execute({ file_path: `${root}/analysis.ipynb` }, context);

    assert.strictEqual(result.ok, true, JSON.stringify(result));
    // The cache filename kept the extension, so dispatch could recognise it.
    const content = result.content as string;
    assert.ok(/notebook|单元格|cell/i.test(content));
  });

  test('HTTP 错误返回清晰信息且不抛异常', async () => {
    const root = await startServer((_req, res) => {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('nope');
    });

    const result = await tool.execute({ file_path: `${root}/missing.txt` }, context);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'TOOL_EXECUTION_ERROR');
    const message = String(result.message || '');
    assert.ok(message.includes('404'), message);
    assert.ok(message.includes(`${root}/missing.txt`), message);
  });

  test('content-length 超过上限时拒绝下载', async () => {
    const root = await startServer((_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(MAX_URL_DOWNLOAD_BYTES + 1),
      });
      res.end('');
    });

    const result = await tool.execute({ file_path: `${root}/huge.bin` }, context);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'TOOL_EXECUTION_ERROR');
    assert.ok(String(result.message || '').includes('过大'), String(result.message));
  });

  test('服务端不可达时返回下载失败而不是崩溃', async () => {
    // Port 1 is reserved and never listening, so the connection is refused.
    const result = await tool.execute({ file_path: 'http://127.0.0.1:1/unreachable.txt' }, context);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'TOOL_EXECUTION_ERROR');
    assert.ok(String(result.message || '').includes('下载失败'), String(result.message));
  });

  test('回归：本地路径仍走原有逻辑，不进入下载分支', async () => {
    const filePath = path.join(testRoot, 'local.txt');
    fs.writeFileSync(filePath, '本地内容\n');

    const result = await tool.execute({ file_path: filePath }, context);

    assert.strictEqual(result.ok, true);
    assert.ok((result.content as string).includes('本地内容'));
    // No HTTP server was ever started, so a stray fetch would have failed.
    assert.strictEqual(server, undefined);
  });

  test('回归：本地路径不存在时仍报文件不存在', async () => {
    const result = await tool.execute({ file_path: path.join(testRoot, 'nope.txt') }, context);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'FILE_NOT_FOUND');
  });
});
