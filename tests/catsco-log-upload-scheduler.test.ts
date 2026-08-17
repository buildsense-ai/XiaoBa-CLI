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
    appendChunkBytes: process.env.CATSCO_LOG_APPEND_CHUNK_BYTES,
    maxAppendChunks: process.env.CATSCO_LOG_MAX_APPEND_CHUNKS_PER_FILE,
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
    restoreEnv('CATSCO_LOG_APPEND_CHUNK_BYTES', originalEnv.appendChunkBytes);
    restoreEnv('CATSCO_LOG_MAX_APPEND_CHUNKS_PER_FILE', originalEnv.maxAppendChunks);
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
            expires_at: '2099-05-14T01:00:00.000Z',
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

  test('persists bootstrap expiry and refreshes a token five minutes before it expires', async () => {
    writeLog('logs/sessions/chat/2026-05-14/first.jsonl', '{"entry_type":"turn","session_id":"first"}\n', true);

    let bootstrapCount = 0;
    const uploadedTokens: string[] = [];
    server = http.createServer((req, res) => {
      drain(req, () => {
        if (req.url === '/catsco/agent/bootstrap') {
          bootstrapCount++;
          const expiresAt = new Date(Date.now() + (bootstrapCount === 1 ? 4 : 60) * 60 * 1000).toISOString();
          respondBootstrap(res, `token-${bootstrapCount}`, expiresAt);
          return;
        }
        if (req.url === '/catsco/logs/upload') {
          uploadedTokens.push(String(req.headers.authorization));
          respondUpload(res);
          return;
        }
        respondNotFound(res);
      });
    });

    configureUploader(await listen());
    const scheduler = new CatscoLogUploadScheduler(testRoot);
    await scheduler.runPendingUploadCycle('manual');

    assert.equal(bootstrapCount, 1);
    assert.deepEqual(uploadedTokens, ['Bearer token-1']);
    assert.ok(readState().tokenExpiresAt);

    writeLog('logs/sessions/chat/2026-05-14/second.jsonl', '{"entry_type":"turn","session_id":"second"}\n', true);
    await scheduler.runPendingUploadCycle('manual');

    assert.equal(bootstrapCount, 2);
    assert.deepEqual(uploadedTokens, ['Bearer token-1', 'Bearer token-2']);
    assert.equal(readState().token, 'token-2');
  });

  test('rebootstraps after a 401 and retries the current snapshot once in the same cycle', async () => {
    writeLog('logs/sessions/chat/2026-05-14/retry.jsonl', '{"entry_type":"turn","session_id":"retry"}\n', true);

    let bootstrapCount = 0;
    const uploadedTokens: string[] = [];
    server = http.createServer((req, res) => {
      drain(req, () => {
        if (req.url === '/catsco/agent/bootstrap') {
          bootstrapCount++;
          respondBootstrap(res, bootstrapCount === 1 ? 'rejected-token' : 'replacement-token');
          return;
        }
        if (req.url === '/catsco/logs/upload') {
          const authorization = String(req.headers.authorization);
          uploadedTokens.push(authorization);
          if (authorization === 'Bearer rejected-token') {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'unauthorized' }));
            return;
          }
          respondUpload(res);
          return;
        }
        respondNotFound(res);
      });
    });

    configureUploader(await listen());
    const scheduler = new CatscoLogUploadScheduler(testRoot);
    await scheduler.runPendingUploadCycle('manual');

    assert.equal(bootstrapCount, 2);
    assert.deepEqual(uploadedTokens, ['Bearer rejected-token', 'Bearer replacement-token']);
    const state = readState();
    assert.equal(state.token, 'replacement-token');
    assert.ok(state.uploaded['logs/sessions/chat/2026-05-14/retry.jsonl']);
  });

  test('stops after one retry when both upload tokens receive 401 responses', async () => {
    writeLog('logs/sessions/chat/2026-05-14/twice-rejected.jsonl', '{"entry_type":"turn","session_id":"twice-rejected"}\n', true);

    let bootstrapCount = 0;
    let uploadCount = 0;
    server = http.createServer((req, res) => {
      drain(req, () => {
        if (req.url === '/catsco/agent/bootstrap') {
          bootstrapCount++;
          respondBootstrap(res, `rejected-${bootstrapCount}`);
          return;
        }
        if (req.url === '/catsco/logs/upload') {
          uploadCount++;
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        respondNotFound(res);
      });
    });

    configureUploader(await listen());
    const scheduler = new CatscoLogUploadScheduler(testRoot);
    await scheduler.runPendingUploadCycle('manual');

    assert.equal(bootstrapCount, 2);
    assert.equal(uploadCount, 2);
    const state = readState();
    assert.equal(state.token, undefined);
    assert.equal(state.uploaded['logs/sessions/chat/2026-05-14/twice-rejected.jsonl'], undefined);
  });

  test('ACKs only the frozen upload snapshot when the source file grows during transfer', async () => {
    const relativePath = 'logs/sessions/chat/2026-05-14/growing.jsonl';
    const initialContent = '{"entry_type":"turn","session_id":"growing"}\n';
    const lateContent = '{"entry_type":"runtime","message":"late growth"}\n';
    writeLog(relativePath, initialContent, true);
    const filePath = path.join(testRoot, relativePath);
    const initialSize = Buffer.byteLength(initialContent);
    const uploadBodies: string[] = [];

    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      req.on('end', () => {
        if (req.url === '/catsco/agent/bootstrap') {
          respondBootstrap(res, 'snapshot-token');
          return;
        }
        if (req.url === '/catsco/logs/upload') {
          uploadBodies.push(Buffer.concat(chunks).toString('utf-8'));
          if (uploadBodies.length === 1) {
            fs.appendFileSync(filePath, lateContent, 'utf-8');
          }
          respondUpload(res);
          return;
        }
        respondNotFound(res);
      });
    });

    configureUploader(await listen(), { stableMinutes: 0 });
    const scheduler = new CatscoLogUploadScheduler(testRoot);
    await scheduler.runPendingUploadCycle('manual');

    assert.equal(uploadBodies.length, 1);
    assert.ok(uploadBodies[0].includes(initialContent));
    assert.ok(!uploadBodies[0].includes(lateContent));
    assert.equal(readState().uploaded['logs/sessions/chat/2026-05-14/growing.jsonl'].size, initialSize);
    assert.ok(fs.statSync(filePath).size > initialSize);

    await scheduler.runPendingUploadCycle('manual');
    assert.equal(uploadBodies.length, 2);
    assert.ok(uploadBodies[1].includes(lateContent));
  });

  test('records a quarantined server response as a conflict without marking the file uploaded', async () => {
    const relativePath = 'logs/sessions/chat/2026-05-14/quarantined.jsonl';
    writeLog(relativePath, '{"entry_type":"turn","session_id":"quarantined"}\n', true);
    let uploadCount = 0;

    server = http.createServer((req, res) => {
      drain(req, () => {
        if (req.url === '/catsco/agent/bootstrap') {
          respondBootstrap(res, 'quarantine-token');
          return;
        }
        if (req.url === '/catsco/logs/upload') {
          uploadCount++;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            upload_id: 'quarantine-upload',
            sha256: 'quarantine-sha',
            status: 'created',
            parse_status: 'quarantined',
          }));
          return;
        }
        respondNotFound(res);
      });
    });

    configureUploader(await listen());
    const scheduler = new CatscoLogUploadScheduler(testRoot);
    await scheduler.runPendingUploadCycle('manual');

    const stateKey = 'logs/sessions/chat/2026-05-14/quarantined.jsonl';
    let state = readState();
    assert.equal(state.uploaded[stateKey], undefined);
    assert.equal(state.conflicts[stateKey].parseStatus, 'quarantined');
    assert.equal(state.conflicts[stateKey].uploadId, 'quarantine-upload');

    await scheduler.runPendingUploadCycle('manual');
    state = readState();
    assert.equal(uploadCount, 1);
    assert.ok(state.conflicts[stateKey]);
  });

  test('records oversized stable session files as blocked instead of silently skipping them', async () => {
    const relativePath = 'logs/sessions/chat/2026-05-14/oversized.jsonl';
    writeLog(relativePath, '{"entry_type":"turn","session_id":"oversized","payload":"too-large"}\n', true);
    let uploadCount = 0;

    server = http.createServer((req, res) => {
      drain(req, () => {
        if (req.url === '/catsco/agent/bootstrap') {
          respondBootstrap(res, 'oversize-token');
          return;
        }
        if (req.url === '/catsco/logs/upload') {
          uploadCount++;
          respondUpload(res);
          return;
        }
        respondNotFound(res);
      });
    });

    configureUploader(await listen(), { maxFileBytes: 10 });
    delete process.env.CATSCO_USER_TOKEN;
    const scheduler = new CatscoLogUploadScheduler(testRoot);
    await scheduler.runPendingUploadCycle('manual');

    const stateKey = 'logs/sessions/chat/2026-05-14/oversized.jsonl';
    const state = readState();
    assert.equal(uploadCount, 0);
    assert.equal(state.uploaded[stateKey], undefined);
    assert.equal(state.blocked[stateKey].reason, 'file_too_large');
    assert.equal(state.blocked[stateKey].maxFileBytes, 10);
  });

  test('uses bounded v2 appends for a session log above the legacy whole-file limit', async () => {
    const relativePath = 'logs/sessions/chat/2026-05-14/incremental.jsonl';
    const payload = 'x'.repeat(1100);
    const lines = [
      `{"entry_type":"turn","session_id":"incremental","turn":1,"payload":"${payload}"}\n`,
      `{"entry_type":"turn","session_id":"incremental","turn":2,"payload":"${payload}"}\n`,
      `{"entry_type":"turn","session_id":"incremental","turn":3,"payload":"${payload}"}\n`,
    ];
    writeLog(relativePath, lines.join(''), true);
    const appendBodies: string[] = [];

    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      req.on('end', () => {
        if (req.url === '/catsco/agent/bootstrap') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            user_id: 'catsco_123',
            external_provider: 'catsco',
            external_user_id: '123',
            device_id: 'device_test',
            token_id: 'token-v2',
            token: 'append-token',
            upload_url: '/catsco/logs/upload',
            upload_protocol: 2,
            append_url: '/catsco/logs/append',
            issued_at: '2026-05-14T00:00:00.000Z',
            expires_at: '2099-05-14T01:00:00.000Z',
          }));
          return;
        }
        if (req.url === '/catsco/logs/append') {
          const index = appendBodies.length;
          const body = Buffer.concat(chunks).toString('utf-8');
          appendBodies.push(body);
          assert.ok(body.includes(lines[index]));
          const expectedOffset = Number(req.headers['x-catslog-expected-offset']);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            upload_id: `append-${index + 1}`,
            sha256: `chunk-${index + 1}`,
            status: index === 0 ? 'created' : 'appended',
            accepted_offset: expectedOffset + Buffer.byteLength(lines[index]),
            revision: String(index + 1).repeat(64),
          }));
          return;
        }
        respondNotFound(res);
      });
    });

    configureUploader(await listen(), {
      maxFileBytes: 10,
      appendChunkBytes: Buffer.byteLength(lines[0]),
      maxAppendChunksPerFile: 3,
    });
    const scheduler = new CatscoLogUploadScheduler(testRoot);
    await scheduler.runPendingUploadCycle('manual');

    const stateKey = 'logs/sessions/chat/2026-05-14/incremental.jsonl';
    const state = readState();
    assert.equal(appendBodies.length, 3);
    assert.equal(state.blocked[stateKey], undefined);
    assert.equal(state.appends[stateKey].offset, Buffer.byteLength(lines.join('')));
    assert.equal(state.appends[stateKey].revision, '3'.repeat(64));
  });

  test('persists a v2 409 server state and permanently retires its stale in-flight request', async () => {
    const relativePath = 'logs/sessions/chat/2026-05-14/conflicted.jsonl';
    const firstLine = '{"entry_type":"turn","session_id":"conflicted","turn":1}\n';
    writeLog(relativePath, firstLine, true);
    const stateKey = 'logs/sessions/chat/2026-05-14/conflicted.jsonl';
    let appendRequests = 0;
    const serverRevision = 'a'.repeat(64);

    server = http.createServer((req, res) => {
      drain(req, () => {
        if (req.url === '/catsco/agent/bootstrap') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            user_id: 'catsco_123',
            external_provider: 'catsco',
            external_user_id: '123',
            device_id: 'device_test',
            token_id: 'token-v2-conflict',
            token: 'append-token',
            upload_url: '/catsco/logs/upload',
            upload_protocol: 2,
            append_url: '/catsco/logs/append',
            issued_at: '2026-05-14T00:00:00.000Z',
            expires_at: '2099-05-14T01:00:00.000Z',
          }));
          return;
        }
        if (req.url === '/catsco/logs/append') {
          appendRequests++;
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'append_conflict',
            accepted_offset: 123,
            revision: serverRevision,
          }));
          return;
        }
        respondNotFound(res);
      });
    });

    configureUploader(await listen(), {
      stableMinutes: 0,
      maxFileBytes: 10,
      appendChunkBytes: Buffer.byteLength(firstLine),
      maxAppendChunksPerFile: 1,
    });
    const scheduler = new CatscoLogUploadScheduler(testRoot);
    await scheduler.runPendingUploadCycle('manual');

    let state = readState();
    assert.equal(appendRequests, 1);
    assert.equal(state.conflicts[stateKey].status, 'append_conflict');
    assert.equal(state.conflicts[stateKey].acceptedOffset, 123);
    assert.equal(state.conflicts[stateKey].revision, serverRevision);
    assert.equal(state.appends[stateKey].inFlight, undefined);

    const filePath = path.join(testRoot, relativePath);
    fs.appendFileSync(filePath, '{"entry_type":"turn","session_id":"conflicted","turn":2}\n', 'utf-8');
    markOld(filePath);
    await scheduler.runPendingUploadCycle('manual');

    state = readState();
    assert.equal(appendRequests, 1);
    assert.equal(state.conflicts[stateKey].revision, serverRevision);
  });

  test('replays a lost v2 append response with the same durable request ID', async () => {
    const relativePath = 'logs/sessions/chat/2026-05-14/replay.jsonl';
    const line = '{"entry_type":"turn","session_id":"replay","turn":1}\n';
    writeLog(relativePath, line, true);
    const stateKey = 'logs/sessions/chat/2026-05-14/replay.jsonl';
    const appendHeaders: Array<{ requestId: string; expectedOffset: string; expectedRevision: string }> = [];

    server = http.createServer((req, res) => {
      drain(req, () => {
        if (req.url === '/catsco/agent/bootstrap') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            user_id: 'catsco_123',
            external_provider: 'catsco',
            external_user_id: '123',
            device_id: 'device_test',
            token_id: 'token-v2-replay',
            token: 'append-token',
            upload_url: '/catsco/logs/upload',
            upload_protocol: 2,
            append_url: '/catsco/logs/append',
            issued_at: '2026-05-14T00:00:00.000Z',
            expires_at: '2099-05-14T01:00:00.000Z',
          }));
          return;
        }
        if (req.url === '/catsco/logs/append') {
          appendHeaders.push({
            requestId: String(req.headers['x-catslog-request-id']),
            expectedOffset: String(req.headers['x-catslog-expected-offset']),
            expectedRevision: String(req.headers['x-catslog-expected-revision']),
          });
          if (appendHeaders.length === 1) {
            res.destroy();
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            upload_id: 'append-replay',
            sha256: 'chunk-replay',
            status: 'created',
            accepted_offset: Buffer.byteLength(line),
            revision: 'b'.repeat(64),
          }));
          return;
        }
        respondNotFound(res);
      });
    });

    configureUploader(await listen(), {
      stableMinutes: 0,
      maxFileBytes: 10,
      appendChunkBytes: Buffer.byteLength(line),
      maxAppendChunksPerFile: 1,
    });
    const scheduler = new CatscoLogUploadScheduler(testRoot);
    await scheduler.runPendingUploadCycle('manual');

    let state = readState();
    assert.equal(appendHeaders.length, 1);
    assert.equal(state.appends[stateKey].offset, 0);
    assert.ok(state.appends[stateKey].inFlight?.requestId);

    await scheduler.runPendingUploadCycle('manual');

    state = readState();
    assert.equal(appendHeaders.length, 2);
    assert.deepEqual(appendHeaders[1], appendHeaders[0]);
    assert.equal(state.appends[stateKey].offset, Buffer.byteLength(line));
    assert.equal(state.appends[stateKey].revision, 'b'.repeat(64));
    assert.equal(state.appends[stateKey].inFlight, undefined);
  });

  function writeLog(relativePath: string, content: string, stable: boolean): void {
    const filePath = path.join(testRoot, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    if (stable) {
      markOld(filePath);
    }
  }

  function configureUploader(port: number, options: {
    stableMinutes?: number;
    maxFileBytes?: number;
    appendChunkBytes?: number;
    maxAppendChunksPerFile?: number;
  } = {}): void {
    process.env.CATSCO_LOG_UPLOAD_ENABLED = 'true';
    process.env.CATSCO_LOG_API_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.CATSCO_LOG_STATE_FILE = 'data/catsco-log-state.json';
    process.env.CATSCO_LOG_STABLE_MINUTES = String(options.stableMinutes ?? 5);
    process.env.CATSCO_LOG_MAX_FILE_BYTES = String(options.maxFileBytes ?? 25 * 1024 * 1024);
    process.env.CATSCO_LOG_APPEND_CHUNK_BYTES = String(options.appendChunkBytes ?? 1024 * 1024);
    process.env.CATSCO_LOG_MAX_APPEND_CHUNKS_PER_FILE = String(options.maxAppendChunksPerFile ?? 4);
    process.env.CATSCO_LOG_MAX_FILES_PER_CYCLE = '10';
    process.env.CATSCO_USER_TOKEN = 'cats-user-token';
    delete process.env.XIAOBA_ROLE;
  }

  async function listen(): Promise<number> {
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()));
    const address = server!.address();
    assert.ok(address && typeof address === 'object');
    return address.port;
  }

  function readState(): any {
    return JSON.parse(fs.readFileSync(path.join(testRoot, 'data', 'catsco-log-state.json'), 'utf-8'));
  }
});

function drain(req: http.IncomingMessage, callback: () => void): void {
  req.on('end', callback);
  req.resume();
}

function respondBootstrap(res: http.ServerResponse, token: string, expiresAt: string = '2099-05-14T01:00:00.000Z'): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    user_id: 'catsco_123',
    external_provider: 'catsco',
    external_user_id: '123',
    device_id: 'device_test',
    token_id: `token-${token}`,
    token,
    upload_url: '/catsco/logs/upload',
    issued_at: '2026-05-14T00:00:00.000Z',
    expires_at: expiresAt,
  }));
}

function respondUpload(res: http.ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    upload_id: 'upload-1',
    sha256: 'demo-sha',
    status: 'created',
    parse_status: 'parsed',
  }));
}

function respondNotFound(res: http.ServerResponse): void {
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
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
