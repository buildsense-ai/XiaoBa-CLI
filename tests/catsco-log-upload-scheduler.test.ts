import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { CatscoLogUploadScheduler } from '../src/utils/catsco-log-upload-scheduler';
import { CatscoLogAgentClient } from '../src/utils/catsco-log-agent-client';

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
            sha256: crypto.createHash('sha256').update(multipartFileContent(Buffer.concat(chunks))).digest('hex'),
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

  for (const appendTiming of ['before client read', 'after client read']) {
    for (const includeResponseHash of [false, true]) {
      test(`v1 keeps appended bytes pending ${appendTiming} (response hash: ${includeResponseHash})`, async t => {
        const first = '{"entry_type":"turn","message":"first"}\n';
        const tail = '{"entry_type":"turn","message":"追加"}\n';
        const logPath = 'logs/sessions/chat/2026-05-14/chat_cli.jsonl';
        writeLog(logPath, first, true);
        const absolutePath = path.join(testRoot, logPath);
        const originalMtime = fs.statSync(absolutePath).mtimeMs;
        const statePath = configureV1Upload();
        const sent: Buffer[] = [];
        const snapshotPaths: string[] = [];
        t.mock.method(CatscoLogAgentClient.prototype, 'uploadLog', async (input: Parameters<CatscoLogAgentClient['uploadLog']>[0]) => {
          snapshotPaths.push(input.filePath);
          assert.notEqual(input.filePath, absolutePath);
          assert.equal(path.basename(input.filePath), 'chat_cli.jsonl');
          assert.equal(input.token, 'synthetic-upload-token');
          assert.equal(input.logDate, '2026-05-14');
          await Promise.resolve();
          if (sent.length === 0 && appendTiming === 'before client read') fs.appendFileSync(absolutePath, tail);
          const content = fs.readFileSync(input.filePath);
          if (sent.length === 0 && appendTiming === 'after client read') fs.appendFileSync(absolutePath, tail);
          sent.push(content);
          return {
            status: 'created',
            upload_id: `upload-${sent.length}`,
            ...(includeResponseHash && { sha256: crypto.createHash('sha256').update(content).digest('hex').toUpperCase() }),
          };
        });

        const scheduler = new CatscoLogUploadScheduler(testRoot);
        await scheduler.runPendingUploadCycle('manual');
        assert.deepEqual(sent, [Buffer.from(first)]);
        const checkpoint = JSON.parse(fs.readFileSync(statePath, 'utf8')).uploaded[logPath];
        assert.equal(checkpoint.size, Buffer.byteLength(first));
        assert.equal(checkpoint.mtimeMs, originalMtime);
        assert.equal(checkpoint.sha256, crypto.createHash('sha256').update(first).digest('hex'));
        assert.equal(checkpoint.uploadId, 'upload-1');
        assert.equal(fs.existsSync(path.dirname(snapshotPaths[0])), false);

        markOld(absolutePath);
        await scheduler.runPendingUploadCycle('manual');
        assert.deepEqual(sent, [Buffer.from(first), Buffer.from(first + tail)]);
        const completed = JSON.parse(fs.readFileSync(statePath, 'utf8')).uploaded[logPath];
        assert.equal(completed.size, Buffer.byteLength(first + tail));
        assert.equal(completed.sha256, crypto.createHash('sha256').update(first + tail).digest('hex'));
        assert.ok(snapshotPaths.every(filePath => !fs.existsSync(path.dirname(filePath))));
        await scheduler.runPendingUploadCycle('manual');
        assert.equal(sent.length, 2);
      });
    }
  }

  for (const failure of ['upload error', 'rejected status', 'mismatched hash']) {
    test(`v1 cleans snapshots and preserves the last checkpoint after ${failure}`, async t => {
      const first = '{"entry_type":"turn","message":"first"}\n';
      const tail = '{"entry_type":"turn","message":"retry"}\n';
      const logPath = 'logs/sessions/chat/2026-05-14/chat_cli.jsonl';
      writeLog(logPath, first, true);
      const absolutePath = path.join(testRoot, logPath);
      const statePath = configureV1Upload();
      const snapshotPaths: string[] = [];
      let attempts = 0;
      t.mock.method(CatscoLogAgentClient.prototype, 'uploadLog', async (input: Parameters<CatscoLogAgentClient['uploadLog']>[0]) => {
        snapshotPaths.push(input.filePath);
        const content = fs.readFileSync(input.filePath);
        attempts++;
        if (attempts === 2) {
          if (failure === 'upload error') throw new Error('synthetic upload failure');
          if (failure === 'rejected status') return { status: 'rejected' };
          return { status: 'created', sha256: '0'.repeat(64) };
        }
        return { status: 'created', record_id: `record-${attempts}`, sha256: crypto.createHash('sha256').update(content).digest('hex') };
      });
      const scheduler = new CatscoLogUploadScheduler(testRoot);
      await scheduler.runPendingUploadCycle('manual');
      const checkpoint = JSON.parse(fs.readFileSync(statePath, 'utf8')).uploaded[logPath];
      assert.equal(checkpoint.uploadId, 'record-1');

      fs.appendFileSync(absolutePath, tail);
      markOld(absolutePath);
      await scheduler.runPendingUploadCycle('manual');
      assert.equal(attempts, 2);
      assert.deepEqual(JSON.parse(fs.readFileSync(statePath, 'utf8')).uploaded[logPath], checkpoint);
      assert.ok(snapshotPaths.every(filePath => !fs.existsSync(path.dirname(filePath))));

      await scheduler.runPendingUploadCycle('manual');
      const completed = JSON.parse(fs.readFileSync(statePath, 'utf8')).uploaded[logPath];
      assert.equal(attempts, 3);
      assert.equal(completed.size, Buffer.byteLength(first + tail));
      assert.equal(completed.sha256, crypto.createHash('sha256').update(first + tail).digest('hex'));
      assert.equal(completed.uploadId, 'record-3');
      assert.ok(snapshotPaths.every(filePath => !fs.existsSync(path.dirname(filePath))));
      await scheduler.runPendingUploadCycle('manual');
      assert.equal(attempts, 3);
    });
  }

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
            skill_token: 'catslog_skl_test', skill_token_expires_at: new Date(Date.now() + 3600_000).toISOString(), skills_url: '/catsco/agent/skills', issued_at: '2026-05-14T00:00:00.000Z',
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

  for (const mutation of ['rewrite', 'replace', 'append tail']) {
    for (const resumed of [false, true]) {
      test(`v2 checkpoints sent bytes across ${mutation} during append (resumed: ${resumed})`, async () => {
        const prefix = '{"entry_type":"turn","message":"prefix"}\n';
        const chunk = '{"entry_type":"turn","message":"original"}\n';
        const original = prefix + chunk;
        const replacement = original.replace('prefix', 'PREFIX').replace('original', 'REPLACED');
        const tail = '{"entry_type":"turn","message":"追加"}\n';
        const logPath = 'logs/sessions/chat/2026-05-14/chat_cli.jsonl';
        writeLog(logPath, original, true);
        const absolutePath = path.join(testRoot, logPath);
        const digest = (content: string) => crypto.createHash('sha256').update(content).digest('hex');
        const appendRequests: Array<{ offset: number; revision: string; content: Buffer }> = [];
        const snapshots: Buffer[] = [];

        server = http.createServer((req, res) => {
          const chunks: Buffer[] = [];
          req.on('data', content => chunks.push(Buffer.isBuffer(content) ? content : Buffer.from(content)));
          req.on('end', () => {
            const content = multipartFileContent(Buffer.concat(chunks));
            if (req.url === '/catsco/logs/append') {
              const offset = Number(req.headers['x-catslog-expected-offset']);
              appendRequests.push({ offset, revision: String(req.headers['x-catslog-expected-revision']), content });
              if (appendRequests.length === 1) {
                if (mutation === 'append tail') {
                  fs.appendFileSync(absolutePath, tail);
                } else if (mutation === 'rewrite') {
                  fs.writeFileSync(absolutePath, replacement);
                } else {
                  const replacementPath = `${absolutePath}.replacement`;
                  fs.writeFileSync(replacementPath, replacement);
                  fs.renameSync(replacementPath, absolutePath);
                }
                markOld(absolutePath);
              }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ accepted_offset: offset + content.length, revision: `revision-${appendRequests.length}` }));
              return;
            }
            if (req.url === '/catsco/logs/upload') {
              snapshots.push(content);
              // Leave the acknowledged append checkpoint for the next cycle to reconcile.
              if (snapshots.length === 1) {
                res.writeHead(503).end();
                return;
              }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ status: 'created', sha256: digest(replacement) }));
              return;
            }
            res.writeHead(404).end();
          });
        });
        await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()));
        const address = server.address();
        assert.ok(address && typeof address === 'object');
        const statePath = configureV1Upload();
        process.env.CATSCO_LOG_API_BASE_URL = `http://127.0.0.1:${address.port}`;
        fs.writeFileSync(statePath, JSON.stringify({
          token: 'synthetic-upload-token', uploadProtocol: 2, appendUrl: '/catsco/logs/append',
          uploaded: resumed ? {
            [logPath]: {
              size: Buffer.byteLength(prefix), mtimeMs: fs.statSync(absolutePath).mtimeMs,
              sha256: digest(prefix),
              append: { acceptedOffset: Buffer.byteLength(prefix), revision: 'revision-prefix', prefixSha256: digest(prefix) },
            },
          } : {},
        }));
        const checkpoint = () => JSON.parse(fs.readFileSync(statePath, 'utf8')).uploaded[logPath];
        const scheduler = new CatscoLogUploadScheduler(testRoot);

        await scheduler.runPendingUploadCycle('manual');
        assert.deepEqual(appendRequests[0], {
          offset: resumed ? Buffer.byteLength(prefix) : 0,
          revision: resumed ? 'revision-prefix' : '',
          content: Buffer.from(resumed ? chunk : original),
        });
        if (mutation === 'append tail') {
          assert.equal(appendRequests.length, 2);
          assert.deepEqual(appendRequests[1], { offset: Buffer.byteLength(original), revision: 'revision-1', content: Buffer.from(tail) });
          assert.equal(checkpoint().append.acceptedOffset, Buffer.byteLength(original + tail));
          assert.equal(checkpoint().append.prefixSha256, digest(original + tail));
          // The existing cycle-size guard attempts a snapshot after consuming a growing tail.
          assert.deepEqual(snapshots, [Buffer.from(original + tail)]);
        } else {
          assert.equal(appendRequests.length, 1);
          assert.equal(checkpoint().append.acceptedOffset, Buffer.byteLength(original));
          assert.equal(checkpoint().append.prefixSha256, digest(original));
          assert.notEqual(checkpoint().append.prefixSha256, digest(replacement));
          assert.deepEqual(snapshots, [Buffer.from(replacement)]);
        }

        await new CatscoLogUploadScheduler(testRoot).runPendingUploadCycle('manual');
        const expectedContent = mutation === 'append tail' ? original + tail : replacement;
        assert.equal(checkpoint().size, Buffer.byteLength(expectedContent));
        if (mutation === 'append tail') {
          assert.equal(appendRequests.length, 2);
          assert.deepEqual(snapshots, [Buffer.from(original + tail)]);
        } else {
          assert.equal(appendRequests.length, 1);
          assert.deepEqual(snapshots, [Buffer.from(replacement), Buffer.from(replacement)]);
          assert.equal(checkpoint().sha256, digest(replacement));
          assert.equal(checkpoint().append, undefined);
        }
        await scheduler.runPendingUploadCycle('manual');
        assert.equal(appendRequests.length, mutation === 'append tail' ? 2 : 1);
        assert.equal(snapshots.length, mutation === 'append tail' ? 1 : 2);
      });
    }
  }

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

  function configureV1Upload(): string {
    process.env.CATSCO_LOG_UPLOAD_ENABLED = 'true';
    process.env.CATSCO_LOG_API_BASE_URL = 'http://127.0.0.1:1';
    process.env.CATSCO_LOG_STATE_FILE = 'data/catsco-log-state.json';
    process.env.CATSCO_LOG_STABLE_MINUTES = '5';
    process.env.CATSCO_USER_TOKEN = 'synthetic-user-token';
    delete process.env.XIAOBA_ROLE;
    const statePath = path.join(testRoot, 'data/catsco-log-state.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ token: 'synthetic-upload-token', uploadProtocol: 1, uploaded: {} }));
    return statePath;
  }

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
