import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import express from 'express';
import type { Server } from 'http';
import { createApiRouter } from '../src/dashboard/routes/api';
import { loadSkillHubConfig } from '../src/skillhub/config';
import { CATSCO_SKILLHUB_ROOT_PUBLIC_KEYS, SkillHubTrustedRootKey } from '../src/skillhub/trusted-keys';

describe('dashboard connected SkillHub API', () => {
  let testRoot: string;
  let originalCwd: string;
  let originalEnv: string | undefined;
  let dashboardServer: Server | undefined;
  let cloudServer: Server | undefined;
  let dashboardBaseUrl: string;
  let cloudBaseUrl: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    originalEnv = process.env.CATSCO_SKILLHUB_BASE_URL;
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-dashboard-skillhub-connected-'));
    process.chdir(testRoot);
    fs.mkdirSync(path.join(testRoot, 'skills'), { recursive: true });
  });

  afterEach(async () => {
    if (dashboardServer) await close(dashboardServer);
    if (cloudServer) await close(cloudServer);
    process.chdir(originalCwd);
    if (originalEnv === undefined) delete process.env.CATSCO_SKILLHUB_BASE_URL;
    else process.env.CATSCO_SKILLHUB_BASE_URL = originalEnv;
    CATSCO_SKILLHUB_ROOT_PUBLIC_KEYS.splice(0);
    if (fs.existsSync(testRoot)) fs.rmSync(testRoot, { recursive: true, force: true });
  });

  test('proxies login, persists cloud cookie, searches, and installs verified packages', async () => {
    const fixture = createFixture();
    CATSCO_SKILLHUB_ROOT_PUBLIC_KEYS.push(fixture.rootTrust);
    await startCloud(fixture);
    process.env.CATSCO_SKILLHUB_BASE_URL = cloudBaseUrl;
    await startDashboard();

    const login = await post('/api/skillhub/auth/login', { email: 'demo@example.com', password: 'passw0rd!!' });
    assert.equal(login.status, 200);
    assert.equal(login.body.authenticated, true);
    assert.equal(fs.existsSync(path.join(testRoot, 'data/skillhub/session.json')), true);

    const status = await get('/api/skillhub/status');
    assert.equal(status.status, 200);
    assert.equal(status.body.authenticated, true);
    assert.equal(status.body.trustReady, true);

    const application = await post('/api/skillhub/developer/apply', {
      displayName: '合同团队',
      namespace: 'contract-team',
      contact: 'dev@example.com',
      websiteUrl: 'https://example.com',
      reason: '发布合同审查和文档处理类 Skill。',
    });
    assert.equal(application.status, 201);
    assert.equal(application.body.application.namespace, 'contract-team');
    assert.equal(application.body.application.contact, 'dev@example.com');
    assert.equal(application.body.application.websiteUrl, 'https://example.com');

    const search = await get('/api/skillhub/search?q=合同');
    assert.equal(search.status, 200);
    assert.equal(search.body.skills[0].skillId, fixture.entry.skillId);

    const install = await post('/api/skillhub/install', { skillId: fixture.entry.skillId });
    assert.equal(install.status, 200);
    assert.equal(install.body.ok, true);
    assert.equal(fs.existsSync(path.join(install.body.skill.path, 'SKILL.md')), true);
  });

  test('uses the official SkillHub cloud by default', () => {
    delete process.env.CATSCO_SKILLHUB_BASE_URL;
    assert.equal(loadSkillHubConfig().baseUrl, 'https://logs.catsco.fun:9000');
  });

  async function startDashboard(): Promise<void> {
    const app = express();
    app.use(express.json({ limit: '25mb' }));
    app.use('/api', createApiRouter({ getAll: () => [], getService: () => null } as any));
    dashboardServer = await listen(app);
    dashboardBaseUrl = serverBaseUrl(dashboardServer);
  }

  async function startCloud(fixture: ReturnType<typeof createFixture>): Promise<void> {
    const app = express();
    app.use(express.json());
    app.post('/api/auth/login', (_req, res) => {
      res.setHeader('Set-Cookie', 'catsco_session=dashboard-session; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800');
      res.json({ user: fixture.user, roles: ['user'], permissions: [] });
    });
    app.get('/api/auth/me', (req, res) => {
      assert.match(req.header('cookie') || '', /catsco_session=dashboard-session/);
      res.json({ user: fixture.user, roles: ['user'], permissions: [] });
    });
    app.post('/api/developer-applications', (req, res) => {
      assert.deepEqual(req.body, {
        displayName: '合同团队',
        namespace: 'contract-team',
        contact: 'dev@example.com',
        websiteUrl: 'https://example.com',
        reason: '发布合同审查和文档处理类 Skill。',
      });
      res.status(201).json({
        application: {
          id: 'devapp_1',
          userId: fixture.user.id,
          status: 'pending',
          ...req.body,
        },
      });
    });
    app.get('/api/skills', (_req, res) => res.json({ skills: [fixture.entry] }));
    app.get('/api/skills/:skillId', (_req, res) => res.json({ skill: fixture.entry, versions: [fixture.entry] }));
    app.get('/api/trust/public-keys', (_req, res) => res.json(fixture.trust));
    app.get('/api/skills/:skillId/versions/:version/download', (_req, res) => res.type('application/octet-stream').send(fixture.packageBytes));
    cloudServer = await listen(app);
    cloudBaseUrl = serverBaseUrl(cloudServer);
  }

  async function get(route: string): Promise<{ status: number; body: any }> {
    const response = await fetch(`${dashboardBaseUrl}${route}`);
    return { status: response.status, body: await response.json() };
  }

  async function post(route: string, body: any): Promise<{ status: number; body: any }> {
    const response = await fetch(`${dashboardBaseUrl}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
});

function createFixture() {
  const rootKeys = crypto.generateKeyPairSync('ed25519');
  const signingKeys = crypto.generateKeyPairSync('ed25519');
  const rootPublicKeyPem = rootKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const rootPrivateKeyPem = rootKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const signingPublicKeyPem = signingKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const signingPrivateKeyPem = signingKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const rootTrust: SkillHubTrustedRootKey = { keyId: 'root-test', algorithm: 'ed25519', publicKeyPem: rootPublicKeyPem };
  const certPayload = {
    schemaVersion: '1.0.0',
    subject: { keyId: 'signing-test', algorithm: 'ed25519' as const, publicKeyPem: signingPublicKeyPem, fingerprintSha256: fingerprint(signingPublicKeyPem) },
    issuer: { keyId: 'root-test', algorithm: 'ed25519' as const, publicKeyFingerprintSha256: fingerprint(rootPublicKeyPem) },
    usages: ['skillpkg.sign'],
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2036-01-01T00:00:00.000Z',
  };
  const certificate = { ...certPayload, signature: sign(certPayload, rootPrivateKeyPem, 'root-test') };
  const payload = {
    packageSchemaVersion: '1.0.0',
    manifest: {
      id: 'skill.contract-review',
      name: 'contract-review',
      displayName: '合同审查助手',
      version: '1.0.0',
      description: '审查合同条款并识别常见风险。',
      entrypoints: { skillFile: 'SKILL.md' },
    },
    files: [
      file('SKILL.md', '---\nname: contract-review\ndescription: 审查合同条款并识别常见风险。\n---\n\n# 合同审查助手\n'),
      file('skill.json', '{"id":"skill.contract-review","name":"contract-review","version":"1.0.0"}\n'),
    ],
  };
  const signature = sign(payload, signingPrivateKeyPem, 'signing-test');
  const packageObject = { payload, signature, checksum: { algorithm: 'sha256' as const, payloadSha256: sha256(canonicalJson(payload)) } };
  const packageBytes = Buffer.from(`${canonicalJson(packageObject)}\n`, 'utf8');
  const entry = {
    skillId: payload.manifest.id,
    name: payload.manifest.name,
    displayName: payload.manifest.displayName,
    description: payload.manifest.description,
    latestVersion: payload.manifest.version,
    categories: ['法务'],
    tags: ['合同'],
    keywords: ['合同审查'],
    triggerExamples: ['帮我审查合同'],
    author: { name: 'CatsCo' },
    permissions: { filesystem: 'user_selected', network: 'none', shell: 'none', secrets: 'none' },
    runtime: { minAgentVersion: '1.0.0', platforms: ['win32', 'darwin', 'linux'] },
    riskLevel: 'low',
    packageUrl: '/ignored',
    checksumSha256: sha256(packageBytes),
    signature,
  };
  return {
    user: { id: 'usr_1', email: 'demo@example.com', displayName: 'Demo' },
    rootTrust,
    trust: {
      trustModel: 'root-signed-signing-keys' as const,
      root: { keyId: 'root-test', algorithm: 'ed25519' as const, fingerprintSha256: fingerprint(rootPublicKeyPem) },
      keys: [{ keyId: 'signing-test', algorithm: 'ed25519' as const, publicKeyPem: signingPublicKeyPem, fingerprintSha256: fingerprint(signingPublicKeyPem), certificate }],
    },
    entry,
    packageBytes,
  };
}

function file(filePath: string, text: string) {
  const buffer = Buffer.from(text, 'utf8');
  return { path: filePath, size: buffer.length, sha256: sha256(buffer), contentBase64: buffer.toString('base64') };
}

function sign(payload: unknown, privateKeyPem: string, keyId: string) {
  return {
    algorithm: 'ed25519' as const,
    keyId,
    signature: crypto.sign(null, Buffer.from(canonicalJson(payload)), privateKeyPem).toString('base64'),
    signedAt: '2026-01-01T00:00:00.000Z',
  };
}

function fingerprint(publicKeyPem: string): string {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return `sha256:${crypto.createHash('sha256').update(der).digest('hex')}`;
}

function sha256(value: Buffer | string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value: any): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: any): any {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sortValue(item)]),
    );
  }
  return value;
}

function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

function close(server: Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

function serverBaseUrl(server: Server): string {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind to TCP');
  return `http://127.0.0.1:${address.port}`;
}
