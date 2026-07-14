import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import express from 'express';
import type { Server } from 'http';
import { createDashboardAuth } from '../src/dashboard/auth';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(close));
});

function listen(app: express.Express): Promise<Server> {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    servers.push(server);
  });
}

function close(server: Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

function baseUrl(server: Server): string {
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  return `http://127.0.0.1:${addr.port}`;
}

async function startAuthServer(apiKey?: string): Promise<string> {
  const auth = createDashboardAuth({ apiKey });
  const app = express();
  app.use('/api', auth.middleware, (req, res) => {
    if (req.path === '/status') return res.json({ ok: true, authRequired: auth.getStatus().enabled });
    if (req.path === '/readiness') return res.json({ ok: true, authRequired: auth.getStatus().enabled });
    return res.json({ ok: true, path: req.path });
  });
  return baseUrl(await listen(app));
}

describe('dashboard auth middleware', () => {
  test('allows protected routes when auth is disabled', async () => {
    const base = await startAuthServer(undefined);
    const res = await fetch(`${base}/api/protected`);
    assert.equal(res.status, 200);
  });

  test('allows public GET/HEAD status and readiness routes when auth is enabled', async () => {
    const base = await startAuthServer('secret');
    assert.equal((await fetch(`${base}/api/status`)).status, 200);
    assert.equal((await fetch(`${base}/api/status/`)).status, 200);
    assert.equal((await fetch(`${base}/api/readiness`)).status, 200);
    assert.equal((await fetch(`${base}/api/status`, { method: 'HEAD' })).status, 200);
  });

  test('protects unsafe public-path methods and details routes', async () => {
    const base = await startAuthServer('secret');
    assert.equal((await fetch(`${base}/api/status`, { method: 'POST' })).status, 401);
    assert.equal((await fetch(`${base}/api/status/details`)).status, 401);
    assert.equal((await fetch(`${base}/api/readiness/details`)).status, 401);
  });

  test('returns machine-readable codes for missing and invalid keys', async () => {
    const base = await startAuthServer('secret');
    let res = await fetch(`${base}/api/protected`);
    let body = await res.json() as any;
    assert.equal(res.status, 401);
    assert.equal(body.code, 'dashboard_auth_required');

    res = await fetch(`${base}/api/protected`, { headers: { 'x-api-key': 'wrong' } });
    body = await res.json() as any;
    assert.equal(res.status, 403);
    assert.equal(body.code, 'dashboard_auth_invalid');
  });

  test('accepts trimmed X-API-Key and Bearer credentials', async () => {
    const base = await startAuthServer('  secret  ');
    assert.equal((await fetch(`${base}/api/protected`, { headers: { 'x-api-key': ' secret ' } })).status, 200);
    assert.equal((await fetch(`${base}/api/protected`, { headers: { authorization: 'Bearer secret' } })).status, 200);
  });

  test('rate limits invalid keys, includes Retry-After, and lets correct key recover', async () => {
    const base = await startAuthServer('secret');
    for (let i = 0; i < 10; i += 1) {
      const res = await fetch(`${base}/api/protected`, { headers: { 'x-api-key': 'wrong' } });
      assert.equal(res.status, 403);
    }

    let res = await fetch(`${base}/api/protected`, { headers: { 'x-api-key': 'wrong' } });
    const limited = await res.json() as any;
    assert.equal(res.status, 429);
    assert.equal(limited.code, 'dashboard_auth_rate_limited');
    assert.ok(Number(res.headers.get('retry-after')) >= 1);

    res = await fetch(`${base}/api/protected`, { headers: { 'x-api-key': 'secret' } });
    assert.equal(res.status, 200);

    res = await fetch(`${base}/api/protected`, { headers: { 'x-api-key': 'wrong' } });
    assert.equal(res.status, 403);
  });
});
