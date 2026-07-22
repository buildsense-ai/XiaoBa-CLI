import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { analyzeImageWithReaderProxy } from '../src/utils/reader-proxy';

describe('reader proxy authentication', () => {
  const originalEnv = { ...process.env };
  const roots: string[] = [];

  afterEach(() => {
    process.env = { ...originalEnv };
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  test('reuses the logged-in CatsCo account token without a separate reader key', async () => {
    for (const key of [
      'READER_PROXY_API_KEY',
      'CATSCO_API_KEY',
      'CATSCOMPANY_API_KEY',
      'READER_PROXY_BEARER_TOKEN',
      'CATSCO_BEARER_TOKEN',
      'CATSCOMPANY_BEARER_TOKEN',
      'CATSCOMPANY_USER_TOKEN',
    ]) delete process.env[key];
    process.env.CATSCO_USER_TOKEN = 'logged-in-user-token';

    let authorization: string | undefined;
    const server = http.createServer((req, res) => {
      authorization = Array.isArray(req.headers.authorization)
        ? req.headers.authorization.join(',')
        : req.headers.authorization;
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ analysis: 'reader-ok' }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('reader test server did not bind');
      process.env.CATSCOMPANY_READER_API_URL = `http://127.0.0.1:${address.port}`;
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-reader-auth-'));
      roots.push(root);
      const filePath = path.join(root, 'probe.png');
      fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      const result = await analyzeImageWithReaderProxy({ filePath });

      assert.equal(result.ok, true);
      assert.equal(result.analysis, 'reader-ok');
      assert.equal(authorization, 'Bearer logged-in-user-token');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  test('falls back from an expired bot key to the logged-in account token', async () => {
    process.env.CATSCO_API_KEY = 'expired-bot-key';
    process.env.CATSCO_USER_TOKEN = 'valid-user-token';
    delete process.env.READER_PROXY_API_KEY;
    delete process.env.CATSCOMPANY_API_KEY;
    delete process.env.READER_PROXY_BEARER_TOKEN;
    delete process.env.CATSCO_BEARER_TOKEN;
    delete process.env.CATSCOMPANY_BEARER_TOKEN;
    delete process.env.CATSCOMPANY_USER_TOKEN;

    const observed: string[] = [];
    const server = http.createServer((req, res) => {
      observed.push(String(req.headers.authorization || ''));
      req.resume();
      req.on('end', () => {
        if (req.headers.authorization === 'ApiKey expired-bot-key') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'expired' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ analysis: 'account-fallback-ok' }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('reader test server did not bind');
      process.env.CATSCOMPANY_READER_API_URL = `http://127.0.0.1:${address.port}`;
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-reader-auth-fallback-'));
      roots.push(root);
      const filePath = path.join(root, 'probe.png');
      fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

      const result = await analyzeImageWithReaderProxy({ filePath });

      assert.equal(result.ok, true);
      assert.equal(result.analysis, 'account-fallback-ok');
      assert.equal(result.attempts, 2);
      assert.deepStrictEqual(observed, ['ApiKey expired-bot-key', 'Bearer valid-user-token']);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
