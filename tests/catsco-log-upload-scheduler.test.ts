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
    maxFileBytes: process.env.CATSCO_LOG_MAX_FILE_BYTES,
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
    restoreEnv('CATSCO_LOG_MAX_FILE_BYTES', originalEnv.maxFileBytes);
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

  test('negotiates v2 append and resumes from the persisted byte cursor', async () => {
    const first = '{"entry_type":"turn","session_id":"cli"}\n';
    const second = '{"entry_type":"runtime","session_id":"cli","message":"next"}\n';
    const logPath = 'logs/sessions/chat/2026-05-14/chat_cli.jsonl';
    writeLog(logPath, first, true);
    const appendRequests: Array<{ offset: string | undefined; revision: string | undefined; requestId: string | undefined; content: Buffer }> = [];

    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      req.on('end', () => {
        if (req.url === '/catsco/agent/bootstrap') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            user_id: 'catsco_123', external_provider: 'catsco', external_user_id: '123',
            device_id: 'device_test', token_id: 'token-1', token: 'log-upload-token',
            upload_url: '/catsco/logs/upload', upload_protocol: 2, append_url: '/catsco/logs/append',
            skill_token: 'catslog_skl_test', skills_url: '/catsco/agent/skills', issued_at: '2026-05-14T00:00:00.000Z',
          }));
          return;
        }
        if (req.url === '/catsco/logs/append') {
          const body = Buffer.concat(chunks);
          const content = multipartFileContent(body);
          const offset = req.headers['x-catslog-expected-offset'];
          const revision = req.headers['x-catslog-expected-revision'];
          const requestId = req.headers['x-catslog-request-id'];
          appendRequests.push({
            offset: Array.isArray(offset) ? offset[0] : offset,
            revision: Array.isArray(revision) ? revision[0] : revision,
            requestId: Array.isArray(requestId) ? requestId[0] : requestId,
            content,
          });
          const acceptedOffset = Number(offset) + content.length;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ accepted_offset: acceptedOffset, revision: `revision-${appendRequests.length}` }));
          return;
        }
        res.writeHead(404).end();
      });
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    process.env.CATSCO_LOG_UPLOAD_ENABLED = 'true';
    process.env.CATSCO_LOG_API_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.CATSCO_LOG_STATE_FILE = 'data/catsco-log-state.json';
    process.env.CATSCO_LOG_STABLE_MINUTES = '0';
    process.env.CATSCO_LOG_MAX_FILES_PER_CYCLE = '10';
    process.env.CATSCO_USER_TOKEN = 'cats-user-token';

    const scheduler = new CatscoLogUploadScheduler(testRoot);
    await scheduler.runPendingUploadCycle('manual');
    assert.equal(appendRequests.length, 1);
    assert.equal(appendRequests[0].offset, '0');
    assert.equal(appendRequests[0].revision, '');
    assert.ok(appendRequests[0].requestId);
    assert.deepEqual(appendRequests[0].content, Buffer.from(first));

    const absolutePath = path.join(testRoot, logPath);
    fs.appendFileSync(absolutePath, second, 'utf8');
    markOld(absolutePath);
    await scheduler.runPendingUploadCycle('manual');
    assert.equal(appendRequests.length, 2);
    assert.equal(appendRequests[1].offset, String(Buffer.byteLength(first)));
    assert.equal(appendRequests[1].revision, 'revision-1');
    assert.ok(appendRequests[1].requestId);
    assert.deepEqual(appendRequests[1].content, Buffer.from(second));
    const state = JSON.parse(fs.readFileSync(path.join(testRoot, 'data/catsco-log-state.json'), 'utf8'));
    assert.equal(state.uploadProtocol, 2);
    assert.equal(state.appendUrl, '/catsco/logs/append');
    assert.equal(state.skillsUrl, '/catsco/agent/skills');
    assert.equal(state.uploaded['logs/sessions/chat/2026-05-14/chat_cli.jsonl'].append.acceptedOffset, Buffer.byteLength(first + second));
  });

  test('re-negotiates v2 and uploads files larger than the legacy snapshot limit in chunks', async () => {
    const line = `{"entry_type":"runtime","message":"${'x'.repeat(120)}"}\n`;
    const targetBytes = 4 * 1024 * 1024 + 1024;
    const content = line.repeat(Math.ceil(targetBytes / Buffer.byteLength(line)));
    const logPath = 'logs/sessions/catscompany/2026-07-31/large.jsonl';
    writeLog(logPath, content, true);

    // Simulate a runtime upgraded in place with a legacy v1-only state file.
    fs.mkdirSync(path.join(testRoot, 'data'), { recursive: true });
    fs.writeFileSync(
      path.join(testRoot, 'data/catsco-log-agent-state.json'),
      JSON.stringify({ token: 'legacy-upload-token', uploaded: {} }),
      'utf8',
    );

    let bootstrapRequests = 0;
    let snapshotUploadRequests = 0;
    const appendRequests: Buffer[] = [];
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      req.on('end', () => {
        if (req.url === '/catsco/agent/bootstrap') {
          bootstrapRequests++;
          assert.equal(req.headers.authorization, 'Bearer cats-user-token');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            user_id: 'catsco_123', external_provider: 'catsco', external_user_id: '123',
            device_id: 'device_test', token_id: 'token-2', token: 'v2-upload-token',
            upload_url: '/catsco/logs/upload', upload_protocol: 2, append_url: '/catsco/logs/append',
            issued_at: '2026-05-14T00:00:00.000Z',
          }));
          return;
        }
        if (req.url === '/catsco/logs/append') {
          const body = Buffer.concat(chunks);
          const appendContent = multipartFileContent(body);
          const expectedOffset = Number(req.headers['x-catslog-expected-offset']);
          appendRequests.push(appendContent);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            accepted_offset: expectedOffset + appendContent.length,
            revision: `revision-${appendRequests.length}`,
          }));
          return;
        }
        if (req.url === '/catsco/logs/upload') {
          snapshotUploadRequests++;
          res.writeHead(500).end();
          return;
        }
        res.writeHead(404).end();
      });
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    process.env.CATSCO_LOG_UPLOAD_ENABLED = 'true';
    process.env.CATSCO_LOG_API_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.CATSCO_LOG_STATE_FILE = 'data/catsco-log-agent-state.json';
    process.env.CATSCO_LOG_STABLE_MINUTES = '0';
    process.env.CATSCO_LOG_MAX_FILE_BYTES = '1024';
    process.env.CATSCO_LOG_MAX_FILES_PER_CYCLE = '10';
    process.env.CATSCO_USER_TOKEN = 'cats-user-token';

    const scheduler = new CatscoLogUploadScheduler(testRoot);
    await scheduler.runPendingUploadCycle('manual');

    const expectedBytes = Buffer.byteLength(content);
    assert.equal(bootstrapRequests, 1);
    assert.equal(snapshotUploadRequests, 0);
    assert.ok(appendRequests.length >= 2);
    assert.equal(appendRequests.reduce((total, chunk) => total + chunk.length, 0), expectedBytes);
    const state = JSON.parse(fs.readFileSync(path.join(testRoot, 'data/catsco-log-agent-state.json'), 'utf8'));
    assert.equal(state.uploadProtocol, 2);
    assert.equal(state.uploaded[logPath].size, expectedBytes);
    assert.equal(state.uploaded[logPath].append.acceptedOffset, expectedBytes);

    const appendRequestCount = appendRequests.length;
    await scheduler.runPendingUploadCycle('manual');
    assert.equal(appendRequests.length, appendRequestCount);
  });

  test('extends a v2 append past 4 MiB to preserve an oversized newline-terminated JSONL record', async () => {
    const oversizedRecord = `{"entry_type":"runtime","message":"${'x'.repeat(4 * 1024 * 1024)}"}\n`;
    const trailingRecord = '{"entry_type":"turn","session_id":"after-large-record"}\n';
    const content = oversizedRecord + trailingRecord;
    const logPath = 'logs/sessions/catscompany/2026-07-31/oversized-record.jsonl';
    writeLog(logPath, content, true);

    const appendRequests: Array<{ offset: number; content: Buffer }> = [];
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      req.on('end', () => {
        if (req.url === '/catsco/agent/bootstrap') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            user_id: 'catsco_123', external_provider: 'catsco', external_user_id: '123',
            device_id: 'device_test', token_id: 'token-oversized', token: 'v2-upload-token',
            upload_url: '/catsco/logs/upload', upload_protocol: 2, append_url: '/catsco/logs/append',
            issued_at: '2026-05-14T00:00:00.000Z',
          }));
          return;
        }
        if (req.url === '/catsco/logs/append') {
          const appendContent = multipartFileContent(Buffer.concat(chunks));
          assert.ok(appendContent.subarray(-1).equals(Buffer.from('\n')));
          const expectedOffset = Number(req.headers['x-catslog-expected-offset']);
          appendRequests.push({ offset: expectedOffset, content: appendContent });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            accepted_offset: expectedOffset + appendContent.length,
            revision: `revision-${appendRequests.length}`,
          }));
          return;
        }
        res.writeHead(404).end();
      });
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    process.env.CATSCO_LOG_UPLOAD_ENABLED = 'true';
    process.env.CATSCO_LOG_API_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.CATSCO_LOG_STATE_FILE = 'data/catsco-log-state.json';
    process.env.CATSCO_LOG_STABLE_MINUTES = '0';
    process.env.CATSCO_LOG_MAX_FILE_BYTES = '1024';
    process.env.CATSCO_LOG_MAX_FILES_PER_CYCLE = '10';
    process.env.CATSCO_USER_TOKEN = 'cats-user-token';

    const scheduler = new CatscoLogUploadScheduler(testRoot);
    await scheduler.runPendingUploadCycle('manual');

    const expectedBytes = Buffer.byteLength(content);
    assert.equal(appendRequests.length, 2);
    assert.deepEqual(appendRequests[0], {
      offset: 0,
      content: Buffer.from(oversizedRecord),
    });
    assert.deepEqual(appendRequests[1], {
      offset: Buffer.byteLength(oversizedRecord),
      content: Buffer.from(trailingRecord),
    });
    const state = JSON.parse(fs.readFileSync(path.join(testRoot, 'data/catsco-log-state.json'), 'utf8'));
    assert.equal(state.uploaded[logPath].append.acceptedOffset, expectedBytes);

    const appendRequestCount = appendRequests.length;
    await scheduler.runPendingUploadCycle('manual');
    assert.equal(appendRequests.length, appendRequestCount);
  });

  test('reads only the bootstrapped device principal\'s Skills without a UID selector', async () => {
    const requests: Array<{ url?: string; auth?: string }> = [];
    server = http.createServer((req, res) => {
      requests.push({ url: req.url, auth: req.headers.authorization });
      if (req.url === '/catsco/agent/bootstrap') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          user_id: 'catsco_123', external_provider: 'catsco', external_user_id: '123',
          device_id: 'device_test', token_id: 'token-1', token: 'log-upload-token',
          skill_token: 'catslog_skl_test', skill_token_expires_at: '2099-01-01T00:00:00.000Z',
          skills_url: '/catsco/agent/skills', upload_url: '/catsco/logs/upload', issued_at: '2026-05-14T00:00:00.000Z',
        }));
        return;
      }
      if (req.url === '/catsco/agent/skills?include_content=true&limit=2') {
        assert.equal(req.headers.authorization, 'Bearer catslog_skl_test');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ content_trust: 'untrusted_runtime_skill', skills: [{ handle: 'safe-handle' }] }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    process.env.CATSCO_LOG_API_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.CATSCO_LOG_STATE_FILE = 'data/catsco-log-state.json';
    process.env.CATSCO_USER_TOKEN = 'cats-user-token';

    const result = await new CatscoLogUploadScheduler(testRoot).readSkills({ includeContent: true, limit: 2 });
    assert.equal(result.content_trust, 'untrusted_runtime_skill');
    assert.equal(requests.filter(item => item.url === '/catsco/agent/bootstrap').length, 1);
    assert.equal(requests.filter(item => item.url?.startsWith('/catsco/agent/skills')).length, 1);
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

function multipartFileContent(body: Buffer): Buffer {
  const separator = Buffer.from('\r\n\r\n');
  const start = body.lastIndexOf(separator);
  const end = body.lastIndexOf(Buffer.from('\r\n--'));
  assert.ok(start >= 0 && end > start);
  return body.subarray(start + separator.length, end);
}

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
