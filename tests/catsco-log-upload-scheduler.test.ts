import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { CatscoLogUploadScheduler } from '../src/utils/catsco-log-upload-scheduler';

describe('CatscoLogUploadScheduler', () => {
  let testRoot: string;
  let server: http.Server | null = null;
  const originalEnv = {
    uploadEnabled: process.env.CATSCO_LOG_UPLOAD_ENABLED,
    apiBaseUrl: process.env.CATSCO_LOG_API_BASE_URL,
    stateFile: process.env.CATSCO_LOG_STATE_FILE,
    stableMinutes: process.env.CATSCO_LOG_STABLE_MINUTES,
    maxFiles: process.env.CATSCO_LOG_MAX_FILES_PER_CYCLE,
    catscoUserToken: process.env.CATSCO_USER_TOKEN,
    role: process.env.XIAOBA_ROLE,
  };

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-catslog-upload-'));
  });

  afterEach(async () => {
    if (server) {
      await new Promise(resolve => server?.close(resolve));
      server = null;
    }
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }

    restoreEnv('CATSCO_LOG_UPLOAD_ENABLED', originalEnv.uploadEnabled);
    restoreEnv('CATSCO_LOG_API_BASE_URL', originalEnv.apiBaseUrl);
    restoreEnv('CATSCO_LOG_STATE_FILE', originalEnv.stateFile);
    restoreEnv('CATSCO_LOG_STABLE_MINUTES', originalEnv.stableMinutes);
    restoreEnv('CATSCO_LOG_MAX_FILES_PER_CYCLE', originalEnv.maxFiles);
    restoreEnv('CATSCO_USER_TOKEN', originalEnv.catscoUserToken);
    restoreEnv('XIAOBA_ROLE', originalEnv.role);
  });

  test('bootstraps with CatsCo login token and uploads only stable session jsonl files once', async () => {
    writeLog('logs/sessions/chat/2026-05-14/chat_cli.jsonl', '{"entry_type":"turn","session_id":"cli"}\n', true);
    writeLog('logs/sessions/weixin/2026-05-14/weixin_user_demo.jsonl', '{"entry_type":"turn","session_id":"user:demo"}\n', true);
    writeLog('logs/sessions/chat/2026-05-14/fresh.jsonl', '{"entry_type":"turn","session_id":"fresh"}\n', false);
    writeLog('logs/sessions/unknown/2026-05-14/unknown.jsonl', '{"entry_type":"turn"}\n', true);
    writeLog('logs/provider-messages/2026-05-14/provider.jsonl', '{"entry_type":"provider_messages"}\n', true);
    writeLog('logs/context-debug/debug.json', '{"debug":true}\n', true);
    writeLog('logs/2026-05-14/runtime.log', '[INFO] runtime\n', true);

    const requests: Array<{ url?: string; auth?: string; body: string }> = [];
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('latin1');
        requests.push({ url: req.url, auth: req.headers.authorization, body });

        if (req.url === '/catsco/agent/bootstrap') {
          assert.equal(req.headers.authorization, 'Bearer cats-user-token');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            user_id: 'catsco_123',
            external_provider: 'catsco',
            external_user_id: '123',
            device_id: 'device_test',
            token_id: 'token-1',
            token: 'log-upload-token',
            upload_url: '/catsco/logs/upload',
            issued_at: '2026-05-14T00:00:00.000Z',
          }));
          return;
        }

        if (req.url === '/catsco/logs/upload') {
          assert.equal(req.headers.authorization, 'Bearer log-upload-token');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            upload_id: `upload-${requests.filter(item => item.url === '/catsco/logs/upload').length}`,
            sha256: 'demo-sha',
            parse_status: 'parsed',
          }));
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      });
    });

    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    assert.ok(address && typeof address === 'object');

    process.env.CATSCO_LOG_UPLOAD_ENABLED = 'true';
    process.env.CATSCO_LOG_API_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.CATSCO_LOG_STATE_FILE = 'data/catsco-log-state.json';
    process.env.CATSCO_LOG_STABLE_MINUTES = '5';
    process.env.CATSCO_LOG_MAX_FILES_PER_CYCLE = '10';
    process.env.CATSCO_USER_TOKEN = 'cats-user-token';
    delete process.env.XIAOBA_ROLE;

    const scheduler = new CatscoLogUploadScheduler(testRoot);
    await scheduler.runPendingUploadCycle('manual');

    const bootstrapRequests = requests.filter(item => item.url === '/catsco/agent/bootstrap');
    const uploadRequests = requests.filter(item => item.url === '/catsco/logs/upload');
    assert.equal(bootstrapRequests.length, 1);
    assert.equal(uploadRequests.length, 2);
    assert.ok(uploadRequests.some(item => item.body.includes('filename="chat_cli.jsonl"')));
    assert.ok(uploadRequests.some(item => item.body.includes('filename="weixin_user_demo.jsonl"')));
    assert.ok(!uploadRequests.some(item => item.body.includes('fresh.jsonl')));
    assert.ok(!uploadRequests.some(item => item.body.includes('unknown.jsonl')));
    assert.ok(!uploadRequests.some(item => item.body.includes('provider.jsonl')));
    assert.ok(!uploadRequests.some(item => item.body.includes('runtime.log')));

    await scheduler.runPendingUploadCycle('manual');
    assert.equal(requests.filter(item => item.url === '/catsco/logs/upload').length, 2);

    const changedLog = path.join(testRoot, 'logs/sessions/chat/2026-05-14/chat_cli.jsonl');
    fs.appendFileSync(changedLog, '{"entry_type":"runtime","message":"changed"}\n', 'utf-8');
    markOld(changedLog);
    await scheduler.runPendingUploadCycle('manual');
    assert.equal(requests.filter(item => item.url === '/catsco/logs/upload').length, 3);
  });

  function writeLog(relativePath: string, content: string, stable: boolean): void {
    const filePath = path.join(testRoot, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    if (stable) {
      markOld(filePath);
    }
  }
});

function markOld(filePath: string): void {
  const oldDate = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(filePath, oldDate, oldDate);
}
function restoreEnv(key: string, value: string | undefined): void {
  if (typeof value === 'string') {
    process.env[key] = value;
  } else {
    delete process.env[key];
  }
}
