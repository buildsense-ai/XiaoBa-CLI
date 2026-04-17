import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { InspectorUploadScheduler } from '../src/utils/inspector-upload-scheduler';

describe('InspectorUploadScheduler', () => {
  let testRoot: string;
  let server: http.Server | null = null;
  const originalEnv = {
    inspectorServerUrl: process.env.INSPECTOR_SERVER_URL,
    inspectorServerApiKey: process.env.INSPECTOR_SERVER_API_KEY,
    autoUploadEnabled: process.env.INSPECTOR_AUTO_UPLOAD_ENABLED,
    autoUploadTime: process.env.INSPECTOR_AUTO_UPLOAD_TIME,
    stableMinutes: process.env.INSPECTOR_AUTO_UPLOAD_STABLE_MINUTES,
    maxFiles: process.env.INSPECTOR_AUTO_UPLOAD_MAX_FILES,
    xiaobaRole: process.env.XIAOBA_ROLE,
  };

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-upload-scheduler-'));
  });

  afterEach(async () => {
    if (server) {
      await new Promise(resolve => server?.close(resolve));
      server = null;
    }

    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }

    restoreEnv('INSPECTOR_SERVER_URL', originalEnv.inspectorServerUrl);
    restoreEnv('INSPECTOR_SERVER_API_KEY', originalEnv.inspectorServerApiKey);
    restoreEnv('INSPECTOR_AUTO_UPLOAD_ENABLED', originalEnv.autoUploadEnabled);
    restoreEnv('INSPECTOR_AUTO_UPLOAD_TIME', originalEnv.autoUploadTime);
    restoreEnv('INSPECTOR_AUTO_UPLOAD_STABLE_MINUTES', originalEnv.stableMinutes);
    restoreEnv('INSPECTOR_AUTO_UPLOAD_MAX_FILES', originalEnv.maxFiles);
    restoreEnv('XIAOBA_ROLE', originalEnv.xiaobaRole);
  });

  test('启动补传只上传稳定且未上传过的日志，并在文件变化后再次上传', async () => {
    const runtimeLogDir = path.join(testRoot, 'logs', '2026-04-14');
    const sessionLogDir = path.join(testRoot, 'logs', 'sessions', 'feishu', '2026-04-14');
    fs.mkdirSync(runtimeLogDir, { recursive: true });
    fs.mkdirSync(sessionLogDir, { recursive: true });

    const stableRuntimeLog = path.join(runtimeLogDir, 'stable.log');
    const freshRuntimeLog = path.join(runtimeLogDir, 'fresh.log');
    const stableSessionLog = path.join(sessionLogDir, 'user_demo.jsonl');
    const reviewSessionLog = path.join(sessionLogDir, 'group_demo_inspector-review_case-1.jsonl');
    const oldRuntimeLog = path.join(runtimeLogDir, 'older.log');
    fs.writeFileSync(stableRuntimeLog, '[INFO] stable runtime', 'utf-8');
    fs.writeFileSync(freshRuntimeLog, '[INFO] fresh runtime', 'utf-8');
    fs.writeFileSync(stableSessionLog, '{"turn":1}', 'utf-8');
    fs.writeFileSync(reviewSessionLog, '{"turn":1,"role":"assistant"}', 'utf-8');
    fs.writeFileSync(oldRuntimeLog, '[INFO] old runtime', 'utf-8');

    const oldDate = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(stableRuntimeLog, oldDate, oldDate);
    fs.utimesSync(stableSessionLog, oldDate, oldDate);
    fs.utimesSync(reviewSessionLog, oldDate, oldDate);
    const olderDate = new Date(Date.now() - 30 * 60 * 1000);
    fs.utimesSync(oldRuntimeLog, olderDate, olderDate);

    const receivedBodies: any[] = [];
    const uploadedFiles: Array<{ path?: string; kind?: string }> = [];
    const completedCases: string[] = [];
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      req.on('end', () => {
        const bodyBuffer = Buffer.concat(chunks);
        if (req.url === '/api/inspector/cases') {
          receivedBodies.push(JSON.parse(bodyBuffer.toString('utf-8') || '{}'));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ caseId: `case-${receivedBodies.length}`, status: 'uploading' }));
          return;
        }

        if (/^\/api\/inspector\/cases\/case-\d+\/files$/.test(String(req.url))) {
          const raw = bodyBuffer.toString('latin1');
          uploadedFiles.push({
            path: extractMultipartField(raw, 'path'),
            kind: extractMultipartField(raw, 'kind'),
          });
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        const completeMatch = String(req.url).match(/^\/api\/inspector\/cases\/(case-\d+)\/complete$/);
        if (completeMatch) {
          completedCases.push(completeMatch[1]);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, caseId: completeMatch[1], status: 'received' }));
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      });
    });

    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    assert.ok(address && typeof address === 'object');

    process.env.INSPECTOR_SERVER_URL = `http://127.0.0.1:${address.port}`;
    process.env.INSPECTOR_SERVER_API_KEY = 'demo-key';
    process.env.INSPECTOR_AUTO_UPLOAD_ENABLED = 'true';
    process.env.INSPECTOR_AUTO_UPLOAD_STABLE_MINUTES = '5';
    process.env.INSPECTOR_AUTO_UPLOAD_MAX_FILES = '2';
    delete process.env.XIAOBA_ROLE;

    const scheduler = new InspectorUploadScheduler(testRoot);
    await scheduler.start();

    await waitFor(() => completedCases.length === 1);
    assert.strictEqual(receivedBodies.length, 1);
    assert.deepStrictEqual(
      uploadedFiles.map(file => file.path).sort(),
      ['2026-04-14/stable.log', 'sessions/feishu/2026-04-14/user_demo.jsonl'],
    );
    assert.strictEqual(completedCases.length, 1);
    assert.ok(!uploadedFiles.some(file => file.path === '2026-04-14/older.log'));
    assert.ok(!uploadedFiles.some(file => String(file.path).includes('inspector-review')));

    await scheduler.runPendingUploadCycle('manual');
    assert.strictEqual(receivedBodies.length, 2);
    assert.deepStrictEqual(
      uploadedFiles.slice(2).map(file => file.path),
      ['2026-04-14/older.log'],
    );

    fs.writeFileSync(stableSessionLog, '{"turn":1}\n{"turn":2}', 'utf-8');
    const newerOldDate = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(stableSessionLog, newerOldDate, newerOldDate);

    await scheduler.runPendingUploadCycle('manual');
    assert.strictEqual(receivedBodies.length, 3);
    assert.deepStrictEqual(
      uploadedFiles.slice(3).map(file => file.path),
      ['sessions/feishu/2026-04-14/user_demo.jsonl'],
    );

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

async function waitFor(predicate: () => boolean, maxAttempts: number = 40, delayMs: number = 50): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  throw new Error('waitFor timeout');
}
