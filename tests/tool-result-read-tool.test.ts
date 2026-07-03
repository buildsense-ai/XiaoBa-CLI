/**
 * read-tool 测试：验证 ToolExecutionResult 结构
 */
import { describe, test, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as http from 'http';
import { DEFAULT_PDF_IMAGE_FALLBACK_PAGES, DEFAULT_PDF_READ_PAGES, DEFAULT_TEXT_READ_LIMIT, ReadTool } from '../src/tools/read-tool';
import { ToolExecutionContext } from '../src/types/tool';

function writeVectorOnlyPdf(filePath: string): void {
  const stream = [
    '0.85 0.90 1 rg',
    '20 20 160 160 re',
    'f',
    '0.1 0.4 0.7 RG',
    '3 w',
    '20 20 160 160 re',
    'S',
  ].join('\n');
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>\nendobj\n',
    `4 0 obj\n<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}\nendstream\nendobj\n`,
  ];

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(body, 'ascii'));
    body += object;
  }

  const xrefOffset = Buffer.byteLength(body, 'ascii');
  body += `xref\n0 ${objects.length + 1}\n`;
  body += '0000000000 65535 f \n';
  for (const offset of offsets) {
    body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  body += [
    'trailer',
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    'startxref',
    String(xrefOffset),
    '%%EOF',
    '',
  ].join('\n');

  fs.writeFileSync(filePath, body, 'ascii');
}

function writeInlineImagePdf(filePath: string): void {
  const inlineImageData = Buffer.from([
    255, 255, 255,
    210, 80, 80,
    80, 150, 220,
    45, 45, 45,
  ]);
  const stream = Buffer.concat([
    Buffer.from([
      'q',
      '160 0 0 160 20 20 cm',
      'BI',
      '/W 2',
      '/H 2',
      '/CS /RGB',
      '/BPC 8',
      'ID ',
    ].join('\n'), 'ascii'),
    inlineImageData,
    Buffer.from('\nEI\nQ\n', 'ascii'),
  ]);
  const objects = [
    Buffer.from('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n', 'ascii'),
    Buffer.from('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n', 'ascii'),
    Buffer.from('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>\nendobj\n', 'ascii'),
    Buffer.concat([
      Buffer.from(`4 0 obj\n<< /Length ${stream.length} >>\nstream\n`, 'ascii'),
      stream,
      Buffer.from('\nendstream\nendobj\n', 'ascii'),
    ]),
  ];

  const chunks: Buffer[] = [Buffer.from('%PDF-1.4\n', 'ascii')];
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(Buffer.concat(chunks).length);
    chunks.push(object);
  }

  const bodyBeforeXref = Buffer.concat(chunks);
  let xref = `xref\n0 ${objects.length + 1}\n`;
  xref += '0000000000 65535 f \n';
  for (const offset of offsets) {
    xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  xref += [
    'trailer',
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    'startxref',
    String(bodyBeforeXref.length),
    '%%EOF',
    '',
  ].join('\n');

  fs.writeFileSync(filePath, Buffer.concat([bodyBeforeXref, Buffer.from(xref, 'ascii')]));
}

describe('ReadTool - ToolExecutionResult', () => {
  let tool: ReadTool;
  let testRoot: string;
  let context: ToolExecutionContext;

  beforeEach(() => {
    tool = new ReadTool();
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'read-tool-test-'));
    context = { workingDirectory: testRoot, conversationHistory: [] };
  });

  test('成功读取文本文件返回 ok=true', async () => {
    const filePath = path.join(testRoot, 'sample.txt');
    fs.writeFileSync(filePath, 'line1\nline2\nline3');
    const result = await tool.execute({ file_path: filePath }, context);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(typeof result.content, 'string');
    const content = result.content as string;
    assert.ok(content.includes('sample.txt'));
    assert.ok(content.includes('line1'));
  });

  test('默认只读取文本文件开头窗口', async () => {
    const filePath = path.join(testRoot, 'large.txt');
    const lines = Array.from({ length: DEFAULT_TEXT_READ_LIMIT + 5 }, (_, index) => `line${index + 1}`);
    fs.writeFileSync(filePath, lines.join('\n'));

    const result = await tool.execute({ file_path: filePath }, context);

    assert.strictEqual(result.ok, true);
    const content = result.content as string;
    assert.ok(content.includes(`显示: 1-${DEFAULT_TEXT_READ_LIMIT}`));
    assert.ok(content.includes(`默认只显示 ${DEFAULT_TEXT_READ_LIMIT} 行`));
    assert.ok(content.includes(`offset=${DEFAULT_TEXT_READ_LIMIT + 1}`));
    assert.ok(content.includes(`总行数: 至少 ${DEFAULT_TEXT_READ_LIMIT + 1}`));
    assert.ok(content.includes('line200'));
    assert.ok(!content.includes('line201'));
  });

  test('达到默认窗口后不继续扫描完整文件统计总行数', async () => {
    const filePath = path.join(testRoot, 'huge.txt');
    const lines = Array.from({ length: DEFAULT_TEXT_READ_LIMIT + 5000 }, (_, index) => `line${index + 1}`);
    fs.writeFileSync(filePath, lines.join('\n'));

    const result = await tool.execute({ file_path: filePath }, context);

    assert.strictEqual(result.ok, true);
    const content = result.content as string;
    assert.ok(content.includes(`总行数: 至少 ${DEFAULT_TEXT_READ_LIMIT + 1}`));
    assert.ok(content.includes('已停止继续统计'));
    assert.ok(!content.includes(`总行数: ${DEFAULT_TEXT_READ_LIMIT + 5000}`));
    assert.ok(!content.includes('line201'));
  });

  test('使用 1-based offset 和 limit 返回 ok=true', async () => {
    const filePath = path.join(testRoot, 'long.txt');
    fs.writeFileSync(filePath, 'line1\nline2\nline3\nline4\nline5');
    const result = await tool.execute({ file_path: filePath, offset: 2, limit: 2 }, context);
    assert.strictEqual(result.ok, true);
    const content = result.content as string;
    assert.ok(content.includes('显示: 2-3'));
    assert.ok(content.includes('    2→ line2'));
    assert.ok(!content.includes('    1→ line1'));
  });

  test('显式小 limit 达到窗口后停止扫描并提示至少行数', async () => {
    const filePath = path.join(testRoot, 'small-window.txt');
    fs.writeFileSync(filePath, [
      'before-window',
      'window-first',
      'window-second',
      'after-window',
      'never-scanned-exact-total',
    ].join('\n'));

    const result = await tool.execute({ file_path: filePath, offset: 2, limit: 2 }, context);

    assert.strictEqual(result.ok, true);
    const content = result.content as string;
    assert.ok(content.includes('显示: 2-3'));
    assert.ok(content.includes('    2→ window-first'));
    assert.ok(content.includes('    3→ window-second'));
    assert.ok(content.includes('总行数: 至少 4'));
    assert.ok(content.includes('offset=4, limit=2'));
    assert.ok(content.includes('已停止继续统计'));
    assert.ok(!content.includes('before-window'));
    assert.ok(!content.includes('after-window'));
    assert.ok(!content.includes('never-scanned-exact-total'));
    assert.ok(!content.includes('总行数: 5'));
  });

  test('limit=0 对小文本文件读取全文', async () => {
    const filePath = path.join(testRoot, 'full.txt');
    fs.writeFileSync(filePath, 'line1\nline2\nline3');
    const result = await tool.execute({ file_path: filePath, limit: 0 }, context);
    assert.strictEqual(result.ok, true);
    const content = result.content as string;
    assert.ok(content.includes('显示: 1-3'));
    assert.ok(content.includes('line3'));
    assert.ok(!content.includes('默认只显示'));
  });

  test('文件不存在返回 ok=false + FILE_NOT_FOUND', async () => {
    const result = await tool.execute({ file_path: '/nope/not/exist.txt' }, context);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, 'FILE_NOT_FOUND');
    assert.ok(result.message.includes('文件不存在'));
  });

  test('PDF 文件会提取正文文本', async () => {
    const fixturePath = path.join(
      path.dirname(require.resolve('pdf-parse')),
      'test',
      'data',
      '01-valid.pdf',
    );
    const filePath = path.join(testRoot, 'fixture.pdf');
    fs.copyFileSync(fixturePath, filePath);

    const result = await tool.execute({ file_path: filePath, pages: '1' }, context);

    assert.strictEqual(result.ok, true);
    const content = result.content as string;
    assert.ok(content.includes('类型: PDF'));
    assert.ok(content.includes('总页数:'));
    assert.ok(content.includes('已解析页: 1'));
    assert.ok(content.includes('文本内容:'));
    assert.ok(content.includes('Trace-based'));
    assert.ok(!content.includes('不再做 PDF 全文解析'));
  });

  test('PDF 默认只读取前若干页并提示继续读取', async () => {
    const fixturePath = path.join(
      path.dirname(require.resolve('pdf-parse')),
      'test',
      'data',
      '01-valid.pdf',
    );
    const filePath = path.join(testRoot, 'fixture-default.pdf');
    fs.copyFileSync(fixturePath, filePath);

    const result = await tool.execute({ file_path: filePath }, context);

    assert.strictEqual(result.ok, true);
    const content = result.content as string;
    assert.ok(content.includes(`已解析页: 前 ${DEFAULT_PDF_READ_PAGES} 页`));
    assert.ok(content.includes(`读取范围提示: 仅已读取前 ${DEFAULT_PDF_READ_PAGES} / 共 14 页。`));
    assert.ok(content.includes('不能当作整份 PDF 的完整总结'));
    assert.ok(content.includes('询问是否继续分段读取全文'));
    assert.ok(content.includes(`默认只解析前 ${DEFAULT_PDF_READ_PAGES} 页`));
    assert.ok(content.includes('pages="11-14"'));
  });

  test('PDF pages 参数只返回指定页内容', async () => {
    const fixturePath = path.join(
      path.dirname(require.resolve('pdf-parse')),
      'test',
      'data',
      '01-valid.pdf',
    );
    const filePath = path.join(testRoot, 'fixture-page-filter.pdf');
    fs.copyFileSync(fixturePath, filePath);

    const result = await tool.execute({ file_path: filePath, pages: '2' }, context);

    assert.strictEqual(result.ok, true);
    const content = result.content as string;
    assert.ok(content.includes('已解析页: 2'));
    assert.ok(content.includes('读取范围提示: 仅已读取页 2 / 共 14 页。'));
    assert.ok(content.includes('不能当作整份 PDF 的完整总结'));
    assert.ok(content.includes('Every compiled trace'));
    assert.ok(!content.includes('Trace-based Just-in-Time Type Specialization'));
  });

  test('PDF 有文本层但用户关心视觉内容时会补读少量页面图片', async () => {
    const previousConfigPath = process.env.XIAOBA_CONFIG_PATH;
    const previousReaderUrl = process.env.CATSCOMPANY_READER_API_URL;
    const previousApiKey = process.env.CATSCOMPANY_API_KEY;
    const observedRequests: Buffer[] = [];

    const readerServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        observedRequests.push(Buffer.concat(chunks));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ analysis: `visual supplement ${observedRequests.length}` }));
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
      process.env.CATSCOMPANY_READER_API_URL = `http://127.0.0.1:${address.port}`;
      process.env.CATSCOMPANY_API_KEY = 'cats-reader-test-key';

      const fixturePath = path.join(
        path.dirname(require.resolve('pdf-parse')),
        'test',
        'data',
        '01-valid.pdf',
      );
      const filePath = path.join(testRoot, 'fixture-visual-supplement.pdf');
      fs.copyFileSync(fixturePath, filePath);
      context = {
        ...context,
        conversationHistory: [{ role: 'user', content: '请读取这个 PDF，并检查有没有签名、印章和版式问题' }],
      };

      const result = await tool.execute({ file_path: filePath, pages: '1' }, context);

      assert.strictEqual(result.ok, true);
      assert.strictEqual(observedRequests.length, 1);
      assert.ok(observedRequests[0].includes(Buffer.from('PDF 第 1 页')));
      const content = result.content as string;
      assert.ok(content.includes('文本内容:'));
      assert.ok(content.includes('PDF 文本层已提取'));
      assert.ok(content.includes('视觉补充页码: 1'));
      assert.ok(content.includes('visual supplement 1'));
    } finally {
      if (serverListening) {
        await new Promise<void>(resolve => readerServer.close(() => resolve()));
      }
      if (previousConfigPath === undefined) delete process.env.XIAOBA_CONFIG_PATH;
      else process.env.XIAOBA_CONFIG_PATH = previousConfigPath;
      if (previousReaderUrl === undefined) delete process.env.CATSCOMPANY_READER_API_URL;
      else process.env.CATSCOMPANY_READER_API_URL = previousReaderUrl;
      if (previousApiKey === undefined) delete process.env.CATSCOMPANY_API_KEY;
      else process.env.CATSCOMPANY_API_KEY = previousApiKey;
    }
  });

  test('PDF 默认视觉补读会按页数做保守抽样', () => {
    const defaultSelection = {
      label: `前 ${DEFAULT_PDF_READ_PAGES} 页`,
      maxPageToRender: DEFAULT_PDF_READ_PAGES,
      warnings: [],
    };

    assert.deepStrictEqual(
      (tool as any).getPdfRenderedImagePages(defaultSelection, 2),
      [1, 2],
    );
    assert.deepStrictEqual(
      (tool as any).getPdfRenderedImagePages(defaultSelection, 200),
      Array.from({ length: DEFAULT_PDF_IMAGE_FALLBACK_PAGES }, (_, index) => index + 1),
    );
    assert.deepStrictEqual(
      (tool as any).getPdfRenderedImagePages({
        label: '10-20',
        maxPageToRender: 20,
        selectedPages: new Set([10, 11, 12, 13, 14, 15]),
        warnings: [],
      }, 200),
      [10, 11, 12, 13, 14],
    );
  });

  test('无文本层 PDF 会转图片并通过 reader proxy 读取', async () => {
    const previousConfigPath = process.env.XIAOBA_CONFIG_PATH;
    const previousReaderUrl = process.env.CATSCOMPANY_READER_API_URL;
    const previousApiKey = process.env.CATSCOMPANY_API_KEY;
    let observedRequest:
      | { method?: string; url?: string; authorization?: string; body: Buffer }
      | undefined;

    const readerServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        observedRequest = {
          method: req.method,
          url: req.url,
          authorization: Array.isArray(req.headers.authorization)
            ? req.headers.authorization.join(',')
            : req.headers.authorization,
          body: Buffer.concat(chunks),
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ analysis: 'reader proxy saw rendered pdf page' }));
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
      process.env.CATSCOMPANY_READER_API_URL = `http://127.0.0.1:${address.port}`;
      process.env.CATSCOMPANY_API_KEY = 'cats-reader-test-key';

      const filePath = path.join(testRoot, 'scan-like.pdf');
      writeInlineImagePdf(filePath);
      context = {
        ...context,
        conversationHistory: [{ role: 'user', content: '请读取这个扫描版 PDF 的内容' }],
      };

      const result = await tool.execute({ file_path: filePath }, context);

      assert.strictEqual(result.ok, true);
      assert.strictEqual(observedRequest?.method, 'POST');
      assert.strictEqual(observedRequest?.url, '/analyze');
      assert.strictEqual(observedRequest?.authorization, 'ApiKey cats-reader-test-key');
      assert.ok(observedRequest?.body.includes(Buffer.from('Content-Type: image/png')));
      assert.ok(observedRequest?.body.includes(Buffer.from('PDF 第 1 页')));
      const content = result.content as string;
      assert.ok(content.includes('PDF 文本层未提取到内容'));
      assert.ok(content.includes('已自动转成页面图片继续读取'));
      assert.ok(content.includes('reader proxy saw rendered pdf page'));
    } finally {
      if (serverListening) {
        await new Promise<void>(resolve => readerServer.close(() => resolve()));
      }
      if (previousConfigPath === undefined) delete process.env.XIAOBA_CONFIG_PATH;
      else process.env.XIAOBA_CONFIG_PATH = previousConfigPath;
      if (previousReaderUrl === undefined) delete process.env.CATSCOMPANY_READER_API_URL;
      else process.env.CATSCOMPANY_READER_API_URL = previousReaderUrl;
      if (previousApiKey === undefined) delete process.env.CATSCOMPANY_API_KEY;
      else process.env.CATSCOMPANY_API_KEY = previousApiKey;
    }
  });

  test('损坏 PDF 返回解析失败提示', async () => {
    const filePath = path.join(testRoot, 'dummy.pdf');
    fs.writeFileSync(filePath, '%PDF-1.4 fake content');
    const result = await tool.execute({ file_path: filePath }, context);
    assert.strictEqual(result.ok, true);
    const content = result.content as string;
    assert.ok(content.includes('PDF'));
    assert.ok(content.includes('PDF 解析失败'));
    assert.ok(content.includes('未能提取正文'));
    assert.ok(!content.includes('paper-analysis'));
  });
});
