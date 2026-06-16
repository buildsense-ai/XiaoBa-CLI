import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import express from 'express';
import type { Server } from 'http';
import { SkillHubService } from '../src/skillhub/service';
import type { SkillHubTrustedRootKey } from '../src/skillhub/trusted-keys';
import { CATSCO_SKILLHUB_ROOT_PUBLIC_KEYS } from '../src/skillhub/trusted-keys';

describe('SkillHub connected install service', () => {
  let testRoot: string;
  let originalCwd: string;
  let originalEnv: string | undefined;
  let originalSkillsEnv: string | undefined;
  let server: Server | undefined;
  let baseUrl: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    originalEnv = process.env.CATSCO_SKILLHUB_BASE_URL;
    originalSkillsEnv = process.env.XIAOBA_SKILLS_DIR;
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-skillhub-service-'));
    process.chdir(testRoot);
    process.env.XIAOBA_SKILLS_DIR = path.join(testRoot, 'skills');
    fs.mkdirSync(path.join(testRoot, 'skills'), { recursive: true });
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>(resolve => server!.close(() => resolve()));
      server = undefined;
    }
    process.chdir(originalCwd);
    if (originalEnv === undefined) delete process.env.CATSCO_SKILLHUB_BASE_URL;
    else process.env.CATSCO_SKILLHUB_BASE_URL = originalEnv;
    if (originalSkillsEnv === undefined) delete process.env.XIAOBA_SKILLS_DIR;
    else process.env.XIAOBA_SKILLS_DIR = originalSkillsEnv;
    CATSCO_SKILLHUB_ROOT_PUBLIC_KEYS.splice(0);
    if (fs.existsSync(testRoot)) fs.rmSync(testRoot, { recursive: true, force: true });
  });

  test('logs in, persists session cookie, verifies package, and installs skill files', async () => {
    const fixture = createFixture();
    CATSCO_SKILLHUB_ROOT_PUBLIC_KEYS.push(fixture.rootTrust);
    await startFixtureServer(fixture);
    process.env.CATSCO_SKILLHUB_BASE_URL = baseUrl;

    const service = new SkillHubService();
    const auth = await service.login({ email: 'demo@example.com', password: 'passw0rd!!' });
    assert.equal(auth.authenticated, true);
    assert.equal(fs.existsSync(path.join(testRoot, 'data/skillhub/session.json')), true);

    const install = await new SkillHubService().install(fixture.entry.skillId);

    assert.equal(install.ok, true);
    assert.equal(install.skill.path, path.join(testRoot, 'skills', 'contract-review'));
    assert.equal(fs.existsSync(path.join(install.skill.path, 'SKILL.md')), true);
    assert.equal(fs.existsSync(path.join(install.skill.path, 'skill.json')), false);
    assert.equal(fs.existsSync(path.join(install.skill.path, 'REVIEW.json')), false);
    assert.equal(fs.existsSync(path.join(install.skill.path, 'SBOM.json')), false);
    assert.equal(fs.existsSync(path.join(install.skill.path, '.xiaoba-skillhub-install.json')), false);
  });

  test('does not write files when package checksum verification fails', async () => {
    const fixture = createFixture();
    fixture.packageBytes = Buffer.from(fixture.packageBytes.toString('utf8').replace('合同审查助手', '篡改后的 Skill'), 'utf8');
    CATSCO_SKILLHUB_ROOT_PUBLIC_KEYS.push(fixture.rootTrust);
    await startFixtureServer(fixture);
    process.env.CATSCO_SKILLHUB_BASE_URL = baseUrl;

    await assert.rejects(
      () => new SkillHubService().install(fixture.entry.skillId),
      /checksum mismatch/i,
    );
    assert.equal(fs.existsSync(path.join(testRoot, 'skills', 'contract-review')), false);
  });

  test('installs an explicit version when version detail omits latestVersion', async () => {
    const fixture = createFixture();
    CATSCO_SKILLHUB_ROOT_PUBLIC_KEYS.push(fixture.rootTrust);
    await startFixtureServer(fixture);
    process.env.CATSCO_SKILLHUB_BASE_URL = baseUrl;

    const install = await new SkillHubService().install(fixture.entry.skillId, '1.0.0');

    assert.equal(install.ok, true);
    assert.equal((fixture as any).downloadedVersion, '1.0.0');
    assert.equal(fs.existsSync(path.join(install.skill.path, 'SKILL.md')), true);
  });

  async function startFixtureServer(fixture: ReturnType<typeof createFixture>): Promise<void> {
    const app = express();
    app.use(express.json());
    app.post('/api/auth/login', (_req, res) => {
      res.setHeader('Set-Cookie', 'catsco_session=test-session; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800');
      res.json({ user: { id: 'usr_1', email: 'demo@example.com', displayName: 'Demo' }, roles: ['user'], permissions: [] });
    });
    app.get('/api/auth/me', (req, res) => {
      assert.match(req.header('cookie') || '', /catsco_session=test-session/);
      res.json({ user: { id: 'usr_1', email: 'demo@example.com', displayName: 'Demo' }, roles: ['user'], permissions: [] });
    });
    app.get('/api/trust/public-keys', (_req, res) => {
      res.json(fixture.trust);
    });
    app.get(/^\/api\/skills\/(.+)\/versions\/([^/]+)\/download$/, (req, res) => {
      (fixture as any).downloadedVersion = req.params[1];
      res.type('application/octet-stream').send(fixture.packageBytes);
    });
    app.get(/^\/api\/skills\/(.+)\/versions\/([^/]+)$/, (req, res) => {
      assert.equal(req.params[0], fixture.entry.skillId);
      res.json({
        version: {
          ...fixture.entry,
          latestVersion: undefined,
          version: req.params[1],
        },
      });
    });
    app.get(/^\/api\/skills\/(.+)$/, (req, res) => {
      assert.equal(req.params[0], fixture.entry.skillId);
      res.json({ skill: fixture.entry, versions: [fixture.entry] });
    });
    server = await listen(app);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    baseUrl = `http://127.0.0.1:${address.port}`;
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
  const signingFingerprint = fingerprint(signingPublicKeyPem);
  const certPayload = {
    schemaVersion: '1.0.0',
    subject: { keyId: 'signing-test', algorithm: 'ed25519' as const, publicKeyPem: signingPublicKeyPem, fingerprintSha256: signingFingerprint },
    issuer: { keyId: 'root-test', algorithm: 'ed25519' as const, publicKeyFingerprintSha256: fingerprint(rootPublicKeyPem) },
    usages: ['skillpkg.sign'],
    issuedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2036-01-01T00:00:00.000Z',
  };
  const certificate = {
    ...certPayload,
    signature: sign(certPayload, rootPrivateKeyPem, 'root-test'),
  };
  const payload = {
    packageSchemaVersion: '1.0.0',
    manifest: {
      id: 'lin/contract-review',
      name: 'contract-review',
      displayName: '合同审查助手',
      version: '1.0.0',
      description: '审查合同条款并识别常见风险。',
      entrypoints: { skillFile: 'SKILL.md' },
    },
    files: [
      file('SKILL.md', '---\nname: contract-review\ndescription: 审查合同条款并识别常见风险。\n---\n\n# 合同审查助手\n'),
      file('README.md', '# 合同审查助手\n'),
      file('skill.json', JSON.stringify({
        id: 'lin/contract-review',
        name: 'contract-review',
        version: '1.0.0',
        description: '审查合同条款并识别常见风险。',
      }, null, 2)),
      file('REVIEW.json', JSON.stringify({ riskLevel: 'low' }, null, 2)),
      file('SBOM.json', JSON.stringify({ files: [] }, null, 2)),
    ],
  };
  const signature = sign(payload, signingPrivateKeyPem, 'signing-test');
  const packageObject = {
    payload,
    signature,
    checksum: {
      algorithm: 'sha256',
      payloadSha256: sha256(canonicalJson(payload)),
    },
  };
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
    permissions: { filesystem: 'user_selected', network: 'none', shell: 'none', secrets: 'none' },
    runtime: { minAgentVersion: '1.0.0', platforms: ['win32', 'darwin', 'linux'] },
    riskLevel: 'low',
    packageUrl: '/ignored',
    checksumSha256: sha256(packageBytes),
    signature,
  };
  return {
    rootTrust,
    trust: {
      trustModel: 'root-signed-signing-keys' as const,
      root: { keyId: 'root-test', algorithm: 'ed25519' as const, fingerprintSha256: fingerprint(rootPublicKeyPem) },
      keys: [{ keyId: 'signing-test', algorithm: 'ed25519' as const, publicKeyPem: signingPublicKeyPem, fingerprintSha256: signingFingerprint, certificate }],
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
  const key = crypto.createPublicKey(publicKeyPem);
  const der = key.export({ type: 'spki', format: 'der' });
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
