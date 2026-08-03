import { describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createServer } from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_SKILLHUB_BASE_URL,
  normalizeBaseUrl,
} from '../src/skillhub/config';
import { createSkillHubConnectionError, SkillHubClient } from '../src/skillhub/client';
import { CATSCO_SKILLHUB_ROOT_PUBLIC_KEYS } from '../src/skillhub/trusted-keys';

describe('SkillHub production compatibility', () => {
  test('migrates only the retired official endpoint to the current endpoint', () => {
    assert.equal(normalizeBaseUrl('https://logs.catsco.fun:9000/'), DEFAULT_SKILLHUB_BASE_URL);
    assert.equal(normalizeBaseUrl('https://custom.example.com:9000/'), 'https://custom.example.com:9000');
  });

  test('trusts packages issued by both the previous and current production roots', () => {
    assert.deepEqual(
      CATSCO_SKILLHUB_ROOT_PUBLIC_KEYS.map(root => root.keyId),
      ['catsco-root-prod-2026-01', 'catsco-root-prod-2026-07-30'],
    );
  });

  test('root-key updater preserves existing roots and updates by keyId', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skillhub-root-update-'));
    const trustedKeysPath = path.join(root, 'trusted-keys.ts');
    const publicKeyPath = path.join(root, 'new-root.pem');
    fs.writeFileSync(trustedKeysPath, `export interface SkillHubTrustedRootKey {
  keyId: string;
  algorithm: 'ed25519';
  publicKeyPem: string;
}
export const CATSCO_SKILLHUB_ROOT_PUBLIC_KEYS: SkillHubTrustedRootKey[] = [
  {
    keyId: 'old-root',
    algorithm: 'ed25519',
    publicKeyPem: \`OLD-PEM\`,
  },
];
`, 'utf8');
    fs.writeFileSync(publicKeyPath, 'NEW-PEM\n', 'utf8');

    const env = {
      ...process.env,
      CATSCO_SKILLHUB_TRUSTED_KEYS_PATH: trustedKeysPath,
    };
    const script = path.resolve('scripts/update-skillhub-root-key.mjs');
    execFileSync(process.execPath, [script, 'new-root', publicKeyPath], { env });
    execFileSync(process.execPath, [script, 'new-root', publicKeyPath], { env });

    const updated = fs.readFileSync(trustedKeysPath, 'utf8');
    assert.match(updated, /keyId: "old-root"/);
    assert.match(updated, /keyId: "new-root"/);
    assert.equal((updated.match(/keyId: "new-root"/g) || []).length, 1);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('SkillHub connection diagnostics', () => {
  test('reports DNS failures with a stable code and sanitized target', () => {
    const error = createSkillHubConnectionError(
      { cause: { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND secret' } },
      'https://skillhub.catsco.fun:19990/path?token=secret',
    ) as any;

    assert.equal(error.status, 502);
    assert.equal(error.code, 'skillhub.dns_failed');
    assert.deepEqual(error.details, {
      target: 'https://skillhub.catsco.fun:19990',
      causeCode: 'ENOTFOUND',
    });
    assert.doesNotMatch(error.message, /token|secret/);
  });

  test('distinguishes TLS, connection, and timeout failures', () => {
    const tls = createSkillHubConnectionError(
      { cause: { code: 'CERT_HAS_EXPIRED' } },
      'https://skillhub.example.com',
    ) as any;
    const refused = createSkillHubConnectionError(
      { cause: { code: 'ECONNREFUSED' } },
      'https://skillhub.example.com',
    ) as any;
    const timeout = createSkillHubConnectionError(
      { name: 'AbortError' },
      'https://skillhub.example.com',
    ) as any;

    assert.equal(tls.code, 'skillhub.tls_failed');
    assert.equal(refused.code, 'skillhub.connection_failed');
    assert.equal(timeout.code, 'skillhub.timeout');
    assert.equal(timeout.status, 504);
  });

  test('times out when response headers arrive but the body stalls', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{');
    });
    await listen(server);
    const baseUrl = serverUrl(server);
    try {
      const client = new SkillHubClient({ baseUrl, timeoutMs: 50 });
      await assert.rejects(
        () => client.status(),
        (error: any) => error?.code === 'skillhub.timeout' && error?.status === 504,
      );
    } finally {
      server.closeAllConnections();
      await close(server);
    }
  });

  test('rejects oversized JSON responses before reading the body', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': String(3 * 1024 * 1024),
      });
      res.end('{}');
    });
    await listen(server);
    const baseUrl = serverUrl(server);
    try {
      const client = new SkillHubClient({ baseUrl, timeoutMs: 1_000 });
      await assert.rejects(
        () => client.status(),
        (error: any) => error?.code === 'skillhub.response_too_large',
      );
    } finally {
      server.closeAllConnections();
      await close(server);
    }
  });
});

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

function serverUrl(server: ReturnType<typeof createServer>): string {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind to a TCP port.');
  return `http://127.0.0.1:${address.port}`;
}
