import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { LogIngestScheduler } from '../src/utils/log-ingest-scheduler';

describe('LogIngestScheduler', () => {
  let testRoot: string;
  let server: http.Server | null = null;
  const originalEnv = {
    autoDevServerUrl: process.env.AUTODEV_SERVER_URL,
    autoDevApiKey: process.env.AUTODEV_API_KEY,
    autoEnabled: process.env.LOG_INGEST_AUTO_ENABLED,
    autoTime: process.env.LOG_INGEST_AUTO_TIME,
    stableMinutes: process.env.LOG_INGEST_STABLE_MINUTES,
    maxFiles: process.env.LOG_INGEST_AUTO_MAX_FILES,
    xiaobaRole: process.env.XIAOBA_ROLE,
  };

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-log-ingest-'));
  });

  afterEach(async () => {
    if (server) {
      await new Promise(resolve => server?.close(resolve));
      server = null;
    }

    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }

    restoreEnv('AUTODEV_SERVER_URL', originalEnv.autoDevServerUrl);
    restoreEnv('AUTODEV_API_KEY', originalEnv.autoDevApiKey);
    restoreEnv('LOG_INGEST_AUTO_ENABLED', originalEnv.autoEnabled);
    restoreEnv('LOG_INGEST_AUTO_TIME', originalEnv.autoTime);
    restoreEnv('LOG_INGEST_STABLE_MINUTES', originalEnv.stableMinutes);
    restoreEnv('LOG_INGEST_AUTO_MAX_FILES', originalEnv.maxFiles);
    restoreEnv('XIAOBA_ROLE', originalEnv.xiaobaRole);
  });

  test('启动补传只 ingest 稳定且未上传过的 session 日志，并在文件变化后再次 ingest', async () => {
    const sessionLogDir = path.join(testRoot, 'logs', 'sessions', 'feishu', '2026-04-14');
    fs.mkdirSync(sessionLogDir, { recursive: true });

    const stableSessionLog = path.join(sessionLogDir, 'feishu_user_demo.jsonl');
    const olderSessionLog = path.join(sessionLogDir, 'feishu_group_demo.jsonl');
    const freshSessionLog = path.join(sessionLogDir, 'feishu_user_fresh.jsonl');
    const reviewSessionLog = path.join(sessionLogDir, 'group_demo_inspector-review_case-1.jsonl');
    fs.writeFileSync(stableSessionLog, '{"entry_type":"turn","turn":1,"session_id":"user:demo","session_type":"feishu","timestamp":"2026-04-14T09:00:00.000Z","user":{"text":"a"},"assistant":{"text":"b","tool_calls":[]},"tokens":{"prompt":1,"completion":1}}', 'utf-8');
    fs.writeFileSync(olderSessionLog, '{"entry_type":"turn","turn":1,"session_id":"group:demo","session_type":"feishu","timestamp":"2026-04-14T08:00:00.000Z","user":{"text":"a"},"assistant":{"text":"b","tool_calls":[]},"tokens":{"prompt":1,"completion":1}}', 'utf-8');
    fs.writeFileSync(freshSessionLog, '{"entry_type":"turn","turn":1,"session_id":"user:fresh","session_type":"feishu","timestamp":"2026-04-14T11:00:00.000Z","user":{"text":"a"},"assistant":{"text":"b","tool_calls":[]},"tokens":{"prompt":1,"completion":1}}', 'utf-8');
    fs.writeFileSync(reviewSessionLog, '{"turn":1,"role":"assistant"}', 'utf-8');

    const oldDate = new Date(Date.now() - 10 * 60 * 1000);
    const stableLaterDate = new Date(Date.now() - 8 * 60 * 1000);
    fs.utimesSync(stableSessionLog, oldDate, oldDate);
    fs.utimesSync(freshSessionLog, stableLaterDate, stableLaterDate);
    fs.utimesSync(reviewSessionLog, oldDate, oldDate);
    const olderDate = new Date(Date.now() - 30 * 60 * 1000);
    fs.utimesSync(olderSessionLog, olderDate, olderDate);

    const ingestedLogs: any[] = [];
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      req.on('end', () => {
        const bodyBuffer = Buffer.concat(chunks);
        if (req.url === '/api/logs/ingest') {
          const raw = bodyBuffer.toString('latin1');
          ingestedLogs.push({
            session_type: extractMultipartField(raw, 'session_type'),
            session_id: extractMultipartField(raw, 'session_id'),
            log_date: extractMultipartField(raw, 'log_date'),
            filename: extractFileName(raw),
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ log_id: `log-${ingestedLogs.length}`, size_bytes: bodyBuffer.length }));
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      });
    });

    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    assert.ok(address && typeof address === 'object');

    process.env.AUTODEV_SERVER_URL = `http://127.0.0.1:${address.port}`;
    process.env.AUTODEV_API_KEY = 'demo-key';
    process.env.LOG_INGEST_AUTO_ENABLED = 'true';
    process.env.LOG_INGEST_STABLE_MINUTES = '5';
    process.env.LOG_INGEST_AUTO_MAX_FILES = '2';
    delete process.env.XIAOBA_ROLE;

    const scheduler = new LogIngestScheduler(testRoot);
    await scheduler.start();

    await waitFor(() => ingestedLogs.length === 2);
    assert.deepStrictEqual(
      ingestedLogs.map(item => item.filename).sort(),
      ['feishu_user_demo.jsonl', 'feishu_user_fresh.jsonl'],
    );
    assert.ok(!ingestedLogs.some(item => item.filename === 'feishu_group_demo.jsonl'));
    assert.ok(!ingestedLogs.some(item => String(item.filename).includes('inspector-review')));
    assert.ok(ingestedLogs.some(item => item.session_id === 'user:demo'));
    assert.ok(ingestedLogs.some(item => item.session_id === 'user:fresh'));

    await scheduler.runPendingIngestCycle('manual');
    assert.strictEqual(ingestedLogs.length, 3);
    assert.strictEqual(ingestedLogs[2].filename, 'feishu_group_demo.jsonl');
    assert.strictEqual(ingestedLogs[2].session_id, 'group:demo');

    fs.writeFileSync(stableSessionLog, '{"entry_type":"turn","turn":1,"session_id":"user:demo","session_type":"feishu","timestamp":"2026-04-14T09:00:00.000Z","user":{"text":"a"},"assistant":{"text":"b","tool_calls":[]},"tokens":{"prompt":1,"completion":1}}\n{"entry_type":"runtime","timestamp":"2026-04-14T09:05:00.000Z","session_id":"user:demo","session_type":"feishu","level":"ERROR","message":"tool failed"}', 'utf-8');
    const newerOldDate = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(stableSessionLog, newerOldDate, newerOldDate);

    await scheduler.runPendingIngestCycle('manual');
    assert.strictEqual(ingestedLogs.length, 4);
    assert.strictEqual(ingestedLogs[3].filename, 'feishu_user_demo.jsonl');

    await scheduler.stop();
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (typeof value === 'string') {
    process.env[key] = value;
  } else {
    delete process.env[key];
  }
}

function extractMultipartField(raw: string, fieldName: string): string | undefined {
  const match = raw.match(new RegExp(`name="${fieldName}"\\r\\n\\r\\n([^\\r]+)`));
  return match?.[1];
}

function extractFileName(raw: string): string | undefined {
  const match = raw.match(/filename="([^"]+)"/);
  return match?.[1];
}

async function waitFor(predicate: () => boolean, maxAttempts: number = 40, delayMs: number = 50): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  throw new Error('waitFor timeout');
}
