import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const testFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(testFile), '..');
const smokeScript = path.join(repoRoot, 'scripts', 'catslog-agent-memory-smoke.mjs');

describe('CatsLog Agent Memory staging smoke', () => {
  let server: http.Server;
  let calls: Array<{ path: string; method: string; authorization?: string; body: any }>;

  beforeEach(async () => {
    calls = [];
    server = http.createServer(async (request, response) => {
      const rawBody = await readBody(request);
      const body = rawBody ? JSON.parse(rawBody) : undefined;
      calls.push({
        path: request.url?.split('?')[0] || '/',
        method: request.method || 'GET',
        authorization: request.headers.authorization,
        body,
      });
      response.setHeader('Content-Type', 'application/json');

      if (request.url === '/catsco/agent/bootstrap') {
        return writeJSON(response, 200, {
          user_id: 'user-1',
          external_provider: 'test',
          external_user_id: 'user-1',
          device_id: 'smoke-device',
          token_id: 'upload-id',
          token: 'upload-token',
          skill_token_id: 'skill-token-id',
          skill_token: 'skill-token',
          skill_token_expires_at: '2099-01-01T00:00:00.000Z',
          memory_write_token_id: 'write-token-id',
          memory_write_token: 'write-token',
          memory_write_token_expires_at: '2099-01-01T00:00:00.000Z',
          upload_url: '/catsco/logs/upload',
          issued_at: '2026-08-29T00:00:00.000Z',
        });
      }
      if (request.url?.startsWith('/catsco/agent/skills/') && request.method === 'POST') {
        response.statusCode = 204;
        return response.end();
      }
      if (request.url === '/catsco/agent/memory/notes') {
        return writeJSON(response, 201, { id: 'note-1', kind: 'episode' });
      }
      if (request.url?.startsWith('/catsco/agent/skills?')) {
        return writeJSON(response, 200, {
          content_trust: 'untrusted_runtime_skill',
          skills: [],
        });
      }
      if (request.url?.startsWith('/catsco/agent/skill-graph?')) {
        return writeJSON(response, 200, {
          content_trust: 'untrusted_runtime_skill_graph',
          nodes: [],
          edges: [],
        });
      }
      if (request.url === '/catsco/agent/memory/retrieve') {
        return writeJSON(response, 200, body?.include_content
          ? {
            content_trust: 'untrusted_runtime_memory',
            items: [{ handle: 'release-playbook', revision: 3, content: '# release', retrieval_receipt: 'receipt-1' }],
          }
          : { content_trust: 'untrusted_runtime_memory', items: [] });
      }
      if (request.url === '/catsco/agent/query/v1/sessions') {
        return writeJSON(response, 200, { content_trust: 'untrusted_log_data', records: [] });
      }
      if (request.url === '/catsco/agent/memory/recall') {
        return writeJSON(response, 200, {
          content_trust: 'untrusted_agent_memory',
          session_available: true,
          session: { content_trust: 'untrusted_log_data', records: [] },
        });
      }
      return writeJSON(response, 404, { code: 'not_found' });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  test('runs every route in explicit write mode without printing credentials', async () => {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const result = await runSmoke(`http://127.0.0.1:${address.port}`, ['--write'], {
      CATSLOG_SMOKE_ALLOW_WRITES: 'true',
      CATSLOG_SMOKE_DEVICE_ID: 'test-device',
      CATSLOG_SMOKE_REQUEST_ID: 'test-request-1',
    });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /\[catslog-smoke\] passed/);
    assert.equal(result.stdout.includes('skill-token'), false);
    assert.equal(result.stdout.includes('upload-token'), false);
    assert.equal(result.stdout.includes('write-token'), false);

    const routeCalls = calls.filter(call => call.path !== '/catsco/agent/bootstrap');
    assert.deepEqual(new Set(routeCalls.map(call => call.path)), new Set([
      '/catsco/agent/skills',
      '/catsco/agent/skill-graph',
      '/catsco/agent/memory/retrieve',
      '/catsco/agent/query/v1/sessions',
      '/catsco/agent/memory/recall',
      '/catsco/agent/skills/release-playbook/outcomes',
      '/catsco/agent/memory/notes',
    ]));
    const writeCall = calls.find(call => call.path === '/catsco/agent/memory/notes');
    assert.equal(writeCall?.authorization, 'Bearer write-token');
    const outcomeCall = calls.find(call => call.path.endsWith('/outcomes'));
    assert.equal(outcomeCall?.authorization, 'Bearer skill-token');
    assert.equal(outcomeCall?.body.retrieval_receipt, 'receipt-1');
  });

  test('keeps writes skipped in the default read-only mode', async () => {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const result = await runSmoke(`http://127.0.0.1:${address.port}`, [], {
      CATSLOG_SMOKE_DEVICE_ID: 'read-only-device',
    });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /skill outcome: skipped \(--write required\)/);
    assert.match(result.stdout, /memory note: skipped \(--write required\)/);
    assert.equal(calls.some(call => call.path.endsWith('/outcomes')), false);
    assert.equal(calls.some(call => call.path === '/catsco/agent/memory/notes'), false);
  });
});

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function writeJSON(response: http.ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  if (status >= 200 && status < 300 && status !== 204) response.setHeader('ETag', '"smoke-etag"');
  response.end(JSON.stringify(body));
}

function runSmoke(
  baseUrl: string,
  args: string[],
  extraEnv: Record<string, string>,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [smokeScript, ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CATSLOG_SMOKE_BASE_URL: baseUrl,
        CATSLOG_SMOKE_USER_TOKEN: 'user-token',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
