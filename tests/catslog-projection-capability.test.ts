import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CatscoLogAgentClient } from '../src/utils/catsco-log-agent-client';
import { CatsLogMemoryProvider } from '../src/utils/catslog-memory-provider';
import { fixtureBranch, fixtureRead, fixtureRef } from './helpers/catslog-projection-reference-fixture';

async function fixture(run: (ctx: any) => Promise<void>, mode = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'projection-cap-'));
  const requests: any[] = [];
  const token = 'fixture-device-capability';
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    requests.push({ path: req.url, body, authorization: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/catsco/agent/branch') return res.end(JSON.stringify(fixtureBranch()));
    if (req.url === '/catsco/agent/knowledge/source/read') {
      if (mode === '401') { res.statusCode = 401; return res.end(JSON.stringify({ detail: 'DO_NOT_LOG_SECRET' })); }
      if (mode === 'redirect') { res.statusCode = 302; res.setHeader('Location', '/forbidden'); return res.end(); }
      if (mode === 'length') { res.setHeader('Content-Length', String(3 * 1024 * 1024)); return res.end(); }
      if (mode === 'stream') { res.write(' '.repeat(1024 * 1024)); res.write(' '.repeat(1024 * 1024)); return res.end('x'.repeat(1024)); }
      return res.end(JSON.stringify(fixtureRead()));
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const statePath = path.join(root, 'state.json');
  const state = { schemaVersion: 1, deviceId: 'device', skillToken: token,
    skillTokenExpiresAt: new Date(Date.now() + 86400000).toISOString(), uploaded: {} };
  fs.writeFileSync(statePath, JSON.stringify(state));
  const provider = new CatsLogMemoryProvider(root, { env: {
    CATSCO_LOG_API_BASE_URL: base, CATSCO_LOG_STATE_FILE: statePath,
  } });
  // Use the config's actual state path, not a guessed env alias.
  const config = (provider as any).currentConfig();
  fs.mkdirSync(path.dirname(config.stateFilePath), { recursive: true }); fs.writeFileSync(config.stateFilePath, JSON.stringify(state));
  try { await run({ root, requests, provider, client: new CatscoLogAgentClient(base), token, statePath: config.stateFilePath, state }); }
  finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); }
}

test('real provider branch-issued ref -> streamed source/read uses exact body and pinned device token', async () => {
  await fixture(async ({ provider, requests, token }: any) => {
    await provider.branch({ queryText: '', sources: ['agent_memory'] });
    const read = await provider.readSourceMemoryProjection({ projectionRef: fixtureRef() });
    assert.equal(read.projection.Revision, fixtureRead().projection.Revision);
    assert.deepEqual(requests.map((r: any) => r.path), ['/catsco/agent/branch', '/catsco/agent/knowledge/source/read']);
    assert.deepEqual(requests[1].body, { projection_ref: fixtureRef() });
    assert.ok(requests.every((r: any) => r.authorization === `Bearer ${token}`));
  });
});
test('401 read makes one HTTP attempt, no refresh/bootstrap/state mutation or error-body leakage', async () => {
  await fixture(async ({ provider, requests, statePath }: any) => {
    await provider.branch({}); const before = fs.readFileSync(statePath, 'utf8');
    await assert.rejects(provider.readSourceMemoryProjection({ projectionRef: fixtureRef() }), (e: any) => e.status === 401 && !e.message.includes('DO_NOT_LOG_SECRET'));
    assert.equal(requests.length, 2); assert.equal(fs.readFileSync(statePath, 'utf8'), before);
  }, '401');
});
test('token rotation after issued discovery rejects before HTTP read', async () => {
  await fixture(async ({ provider, requests, statePath, state }: any) => {
    await provider.branch({}); fs.writeFileSync(statePath, JSON.stringify({ ...state, skillToken: 'replacement' }));
    await assert.rejects(provider.readSourceMemoryProjection({ projectionRef: fixtureRef() }), /capability changed/);
    assert.equal(requests.length, 1);
  });
});
for (const mode of ['length', 'stream', 'redirect']) test(`source/read rejects ${mode} before unsafe/unbounded response admission`, async () => {
  await fixture(async ({ client, token, requests }: any) => {
    await assert.rejects(client.readSourceMemoryProjection({ projectionRef: fixtureRef(), token }), mode === 'redirect' ? /fetch failed/ : /byte budget/);
    assert.equal(requests.length, 1);
  }, mode);
});
test('source/read rejects arbitrary URL/path before request', async () => {
  await fixture(async ({ client, token, requests }: any) => {
    await assert.rejects(client.readSourceMemoryProjection({ projectionRef: fixtureRef(), token, sourceReadUrl: 'https://invalid.test/read' }), /endpoint is invalid/);
    assert.equal(requests.length, 0);
  });
});
