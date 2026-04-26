import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { SendToInspectorTool } from '../src/tools/send-to-inspector-tool';

describe('SendToInspectorTool', () => {
  let testRoot: string;
  let originalServerUrl: string | undefined;
  let originalApiKey: string | undefined;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-send-inspector-'));
    originalServerUrl = process.env.INSPECTOR_SERVER_URL;
    originalApiKey = process.env.INSPECTOR_SERVER_API_KEY;
  });

  afterEach(() => {
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
    if (originalServerUrl) {
      process.env.INSPECTOR_SERVER_URL = originalServerUrl;
    } else {
      delete process.env.INSPECTOR_SERVER_URL;
    }
    if (originalApiKey) {
      process.env.INSPECTOR_SERVER_API_KEY = originalApiKey;
    } else {
      delete process.env.INSPECTOR_SERVER_API_KEY;
    }
  });

  test('只会收集 logs 下的 .log 和 .jsonl 并上传到 Inspector', async () => {
    const runtimeLogDir = path.join(testRoot, 'logs', '2026-04-13');
    const sessionLogDir = path.join(testRoot, 'logs', 'sessions', 'feishu', '2026-04-13');
    fs.mkdirSync(runtimeLogDir, { recursive: true });
    fs.mkdirSync(sessionLogDir, { recursive: true });

    fs.writeFileSync(path.join(runtimeLogDir, 'runtime.log'), '[INFO] hello runtime', 'utf-8');
    fs.writeFileSync(
      path.join(sessionLogDir, 'user_ou_demo.jsonl'),
      JSON.stringify({
        turn: 1,
        timestamp: '2026-04-13T10:00:00.000Z',
        session_id: 'user:ou_demo',
        user: { text: '请看一下' },
        assistant: { text: '好的', tool_calls: [] },
        tokens: { input: 10, output: 5, total: 15 },
      }) + '\n',
      'utf-8',
    );

    let receivedBody: any;
    let completionCount = 0;
    const uploadedFiles: Array<{ path?: string; kind?: string; raw: string }> = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      req.on('end', () => {
        const bodyBuffer = Buffer.concat(chunks);
        if (req.url === '/api/inspector/cases') {
          receivedBody = JSON.parse(bodyBuffer.toString('utf-8') || '{}');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ caseId: 'case-demo-1', status: 'received' }));
          return;
        }

        if (req.url === '/api/inspector/cases/case-demo-1/files') {
          const raw = bodyBuffer.toString('latin1');
          uploadedFiles.push({
            path: extractMultipartField(raw, 'path'),
            kind: extractMultipartField(raw, 'kind'),
            raw,
          });
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        if (req.url === '/api/inspector/cases/case-demo-1/complete') {
          completionCount += 1;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, caseId: 'case-demo-1', status: 'received' }));
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      });
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    assert.ok(address && typeof address === 'object');

    process.env.INSPECTOR_SERVER_URL = `http://127.0.0.1:${address.port}`;
    process.env.INSPECTOR_SERVER_API_KEY = 'demo-key';

    try {
      const tool = new SendToInspectorTool();
      const output = await tool.execute(
        {
          analysis_type: 'auto',
          user_request: '请把最近日志交给督察猫看一下',
          date: '2026-04-13',
          max_files: 4,
        },
        {
          workingDirectory: testRoot,
          conversationHistory: [],
        },
      );

      assert.strictEqual(output.ok, true);
      const content = output.content as string;
      assert.match(content, /已上传 Inspector 诊断包/);
      assert.match(content, /caseId: case-demo-1/);
      assert.ok(receivedBody);
      assert.strictEqual(receivedBody.source, 'send_to_inspector_tool');
      assert.strictEqual(receivedBody.analysisType, 'runtime');
      assert.deepStrictEqual(receivedBody.files, []);
      assert.strictEqual(uploadedFiles.length, 2);
      assert.deepStrictEqual(
        uploadedFiles.map(file => file.path).sort(),
        ['2026-04-13/runtime.log', 'sessions/feishu/2026-04-13/user_ou_demo.jsonl'],
      );
      assert.deepStrictEqual(
        uploadedFiles.map(file => file.kind).sort(),
        ['runtime_log', 'session_jsonl'],
      );
      assert.strictEqual(completionCount, 1);
      assert.ok(fs.existsSync(path.join(testRoot, 'files', 'inspector-cases')));
    } finally {
      server.close();
    }
  });

  test('显式路径不允许越过 logs 目录', async () => {
    fs.mkdirSync(path.join(testRoot, 'logs', '2026-04-13'), { recursive: true });
    fs.writeFileSync(path.join(testRoot, 'outside.txt'), 'nope', 'utf-8');

    const tool = new SendToInspectorTool();

    const result = await tool.execute(
      {
        analysis_type: 'runtime',
        log_paths: ['outside.txt'],
      },
      {
        workingDirectory: testRoot,
        conversationHistory: [],
      },
    );
    assert.strictEqual(result.ok, false);
    assert.ok(result.content?.includes('不允许上传非日志文件'));
  });
});

function extractMultipartField(raw: string, fieldName: string): string | undefined {
  const match = raw.match(new RegExp(`name="${fieldName}"\\r\\n\\r\\n([^\\r]+)`));
  return match?.[1];
}
