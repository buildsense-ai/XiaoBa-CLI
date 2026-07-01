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
  let originalSkillsEnv: string | undefined;
  let dashboardServer: Server | undefined;
  let cloudServer: Server | undefined;
  let catsServer: Server | undefined;
  let maliciousServer: Server | undefined;
  let dashboardBaseUrl: string;
  let cloudBaseUrl: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    originalEnv = process.env.CATSCO_SKILLHUB_BASE_URL;
    originalSkillsEnv = process.env.XIAOBA_SKILLS_DIR;
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-dashboard-skillhub-connected-'));
    process.chdir(testRoot);
    process.env.XIAOBA_SKILLS_DIR = path.join(testRoot, 'skills');
    fs.mkdirSync(path.join(testRoot, 'skills'), { recursive: true });
  });

  afterEach(async () => {
    if (dashboardServer) {
      await close(dashboardServer);
      dashboardServer = undefined;
    }
    if (cloudServer) {
      await close(cloudServer);
      cloudServer = undefined;
    }
    if (catsServer) {
      await close(catsServer);
      catsServer = undefined;
    }
    if (maliciousServer) {
      await close(maliciousServer);
      maliciousServer = undefined;
    }
    process.chdir(originalCwd);
    if (originalEnv === undefined) delete process.env.CATSCO_SKILLHUB_BASE_URL;
    else process.env.CATSCO_SKILLHUB_BASE_URL = originalEnv;
    delete process.env.CATSCO_HTTP_BASE_URL;
    delete process.env.CATSCO_USER_TOKEN;
    delete process.env.CATSCO_USER_UID;
    delete process.env.CATSCO_USER_NAME;
    delete process.env.CATSCO_USER_DISPLAY_NAME;
    if (originalSkillsEnv === undefined) delete process.env.XIAOBA_SKILLS_DIR;
    else process.env.XIAOBA_SKILLS_DIR = originalSkillsEnv;
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
    assert.equal(application.status, 410);
    assert.equal(application.body.code, 'skillhub.developer_flow_retired');

    const search = await get('/api/skillhub/search?q=合同');
    assert.equal(search.status, 200);
    assert.equal(search.body.skills[0].skillId, fixture.entry.skillId);

    const install = await post('/api/skillhub/install', { skillId: fixture.entry.skillId });
    assert.equal(install.status, 200);
    assert.equal(install.body.ok, true);
    assert.equal(fs.existsSync(path.join(install.body.skill.path, 'SKILL.md')), true);
  });

  test('searches and installs public SkillHub skills without login', async () => {
    const fixture = createFixture();
    CATSCO_SKILLHUB_ROOT_PUBLIC_KEYS.push(fixture.rootTrust);
    await startCloud(fixture);
    process.env.CATSCO_SKILLHUB_BASE_URL = cloudBaseUrl;
    await startDashboard();

    const search = await get('/api/skillhub/search?q=合同');
    assert.equal(search.status, 200);
    assert.equal(search.body.skills[0].skillId, fixture.entry.skillId);
    assert.equal(fs.existsSync(path.join(testRoot, 'data/skillhub/session.json')), false);

    const install = await post('/api/skillhub/install', { skillId: fixture.entry.skillId });
    assert.equal(install.status, 200);
    assert.equal(install.body.ok, true);
    assert.equal(fs.existsSync(path.join(install.body.skill.path, 'SKILL.md')), true);
  });

  test('quick shares an installed local skill as a regular authenticated SkillHub user', async () => {
    fs.mkdirSync(path.join(testRoot, 'skills', 'quick-demo'), { recursive: true });
    fs.writeFileSync(path.join(testRoot, 'skills', 'quick-demo', 'SKILL.md'), [
      '---',
      'name: quick-demo',
      'description: Quick demo skill',
      '---',
      '',
      '# Quick Demo',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(testRoot, 'skills', 'quick-demo', 'REVIEW.json'), '{}\n');
    fs.writeFileSync(path.join(testRoot, 'skills', 'quick-demo', 'SBOM.json'), '{}\n');
    fs.writeFileSync(path.join(testRoot, 'skills', 'quick-demo', '.xiaoba-bundled-skill.json'), '{}\n');
    fs.writeFileSync(path.join(testRoot, 'skills', 'quick-demo', '.xiaoba-skillhub-install.json'), '{}\n');

    const fixture = createFixture();
    await startCloud(fixture);
    process.env.CATSCO_SKILLHUB_BASE_URL = cloudBaseUrl;
    await startDashboard();

    await post('/api/skillhub/auth/login', { email: 'demo@example.com', password: 'passw0rd!!' });
    const share = await post('/api/skillhub/share-local-skill', { skillName: 'quick-demo' });
    assert.equal(share.status, 201);
    assert.equal(share.body.ok, true);
    assert.equal(share.body.skill.id, 'lin/quick-demo');
    assert.equal(share.body.skill.name, 'quick-demo');
    assert.equal(share.body.submission.request.quickShare, true);
    assert.equal(share.body.submission.request.manifest.id, 'quick-demo');
    assert.equal(share.body.submission.request.manifest.name, 'quick-demo');
    assert.equal(share.body.submission.normalizedManifest.id, 'lin/quick-demo');
    assert.equal(share.body.submission.request.manifest.minAgentVersion, '0.0.0');
    assert.deepEqual(share.body.submission.request.manifest.platforms, []);
    const uploadedPaths = share.body.submission.request.source.files.map((file: any) => file.path);
    assert.equal(uploadedPaths.includes('SKILL.md'), true);
    assert.equal(uploadedPaths.includes('REVIEW.json'), false);
    assert.equal(uploadedPaths.includes('SBOM.json'), false);
    assert.equal(uploadedPaths.includes('.xiaoba-bundled-skill.json'), false);
    assert.equal(uploadedPaths.includes('.xiaoba-skillhub-install.json'), false);
    const skillText = fs.readFileSync(path.join(testRoot, 'skills', 'quick-demo', 'SKILL.md'), 'utf8');
    assert.match(skillText, /skillhub_author:\s+["']?lin["']?/);
    assert.match(skillText, /skillhub_version:\s+["']?1\.0\.0["']?/);
    assert.match(skillText, /skillhub_uploaded_at:/);
  });

  test('connects SkillHub with the current CatsCo login token', async () => {
    const fixture = createFixture();
    await startCloud(fixture);
    await startCatsCo();
    process.env.CATSCO_SKILLHUB_BASE_URL = cloudBaseUrl;
    process.env.CATSCO_HTTP_BASE_URL = serverBaseUrl(catsServer!);
    process.env.CATSCO_USER_TOKEN = 'cats-token';
    process.env.CATSCO_USER_UID = '116';
    process.env.CATSCO_USER_NAME = 'lin';
    process.env.CATSCO_USER_DISPLAY_NAME = 'Lin';
    await startDashboard();

    const exchange = await post('/api/skillhub/auth/catsco', {});
    assert.equal(exchange.status, 200);
    assert.equal(exchange.body.authenticated, true);
    assert.equal(exchange.body.user.displayName, 'Lin');
    assert.equal(fs.existsSync(path.join(testRoot, 'data/skillhub/session.json')), true);
  });

  test('uses the official SkillHub cloud by default', () => {
    delete process.env.CATSCO_SKILLHUB_BASE_URL;
    assert.equal(loadSkillHubConfig().baseUrl, 'https://logs.catsco.fun:9000');
  });

  test('ignores request-supplied SkillHub baseUrl overrides', async () => {
    const fixture = createFixture();
    await startCloud(fixture);
    process.env.CATSCO_SKILLHUB_BASE_URL = cloudBaseUrl;
    const malicious = await startMaliciousSkillHub();
    await startDashboard();

    const login = await post('/api/skillhub/auth/login', {
      email: 'demo@example.com',
      password: 'passw0rd!!',
      baseUrl: malicious.baseUrl,
    });
    assert.equal(login.status, 200);
    assert.equal(login.body.authenticated, true);
    assert.equal(malicious.hits(), 0);

    const status = await get(`/api/skillhub/status?baseUrl=${encodeURIComponent(malicious.baseUrl)}`);
    assert.equal(status.status, 200);
    assert.equal(status.body.baseUrl, cloudBaseUrl);
    assert.equal(malicious.hits(), 0);

    const session = JSON.parse(fs.readFileSync(path.join(testRoot, 'data/skillhub/session.json'), 'utf8'));
    assert.equal(session.baseUrl, cloudBaseUrl);
  });

  test('SkillHub install buttons do not embed registry data in inline handlers', () => {
    const html = fs.readFileSync(path.join(originalCwd, 'dashboard/index.html'), 'utf8');
    const storePage = fs.readFileSync(path.join(originalCwd, 'dashboard/react-src/store-page.tsx'), 'utf8');
    const globalModals = fs.readFileSync(path.join(originalCwd, 'dashboard/react-src/global-modals.tsx'), 'utf8');
    const skillhubScript = fs.readFileSync(path.join(originalCwd, 'dashboard/scripts/skillhub.js'), 'utf8');
    const reactSource = `${storePage}\n${globalModals}`;

    assert.match(storePage, /data-skillhub-install=\{canInstall \? 'true' : undefined\}/);
    assert.match(globalModals, /data-skillhub-install=\{version \? 'true' : undefined\}/);
    assert.doesNotMatch(skillhubScript, /addEventListener\('click'/);
    assert.doesNotMatch(html, /onclick="installSkillHubSkill/);
    assert.match(storePage, /data-skillhub-versions="true"/);
    assert.match(reactSource, /data-skillhub-yank-version="true"/);
    assert.match(reactSource, /data-skillhub-restore-version="true"/);
    assert.match(reactSource, /data-skillhub-delete-version="true"/);
    assert.match(storePage, /onClick=\{\(\) => window\.installSkillHubSkill\?\.\(skillId, latestVersion \|\| undefined\)\}/);
    assert.match(storePage, /onClick=\{\(\) => window\.showSkillHubVersions\?\.\(skillId\)\}/);
    assert.match(reactSource, /onClick=\{\(\) => window\.yankOwnSkillHubVersion\?\.\(packageVersionId\)\}/);
    assert.match(reactSource, /onClick=\{\(\) => window\.restoreOwnSkillHubVersion\?\.\(packageVersionId\)\}/);
    assert.match(reactSource, /onClick=\{\(\) => window\.deleteOwnSkillHubVersion\?\.\(packageVersionId\)\}/);
    assert.match(skillhubScript, /\/api\/skillhub\/me\/package-versions\/' \+ encodeURIComponent\(packageVersionId\) \+ '\/restore'/);
    assert.match(skillhubScript, /\/api\/skillhub\/me\/package-versions\/' \+ encodeURIComponent\(packageVersionId\)/);
    assert.doesNotMatch(html, /onclick="showSkillHubVersions/);
    assert.doesNotMatch(html, /onclick="yankOwnSkillHubVersion/);
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
    app.post('/api/auth/login', (req, res) => {
      assert.deepEqual(req.body, { email: 'demo@example.com', password: 'passw0rd!!' });
      res.setHeader('Set-Cookie', 'catsco_session=dashboard-session; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800');
      res.json({ user: fixture.user, roles: ['user'], permissions: [] });
    });
    app.post('/api/auth/catsco-exchange', (req, res) => {
      assert.equal(req.body.token, 'cats-token');
      assert.equal(req.body.baseUrl, serverBaseUrl(catsServer!));
      assert.deepEqual(req.body.user, {
        uid: '116',
        username: 'lin',
        displayName: 'Lin',
      });
      res.setHeader('Set-Cookie', 'catsco_session=catsco-exchange-session; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800');
      res.json({
        user: { ...fixture.user, displayName: 'Lin' },
        roles: ['user', 'developer'],
        permissions: ['submission.create'],
        developerProfile: { namespace: 'lin' },
      });
    });
    app.get('/api/auth/me', (req, res) => {
      const cookie = req.header('cookie') || '';
      assert.match(cookie, /catsco_session=(dashboard-session|catsco-exchange-session)/);
      const exchanged = cookie.includes('catsco-exchange-session');
      res.json({
        user: exchanged ? { ...fixture.user, displayName: 'Lin' } : fixture.user,
        roles: exchanged ? ['user', 'developer'] : ['user'],
        permissions: exchanged ? ['submission.create'] : [],
        developerProfile: exchanged ? { namespace: 'lin' } : undefined,
      });
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
    app.post('/api/skills/share', (req, res) => {
      const manifest = {
        ...req.body.manifest,
        id: `lin/${req.body.manifest.name}`,
        skillHub: {
          author: 'lin',
          version: '1.0.0',
          uploadedAt: '2026-05-28T00:00:00.000Z',
        },
      };
      res.status(201).json({
        skill: { skillId: manifest.id, name: manifest.name },
        submission: {
          id: 'sub_quick_1',
          status: 'scan_pending',
          manifest,
          normalizedManifest: manifest,
          source: req.body.source,
          request: req.body,
        },
      });
    });
    app.post('/api/developer/submissions', (_req, res) => {
      res.status(403).json({ error: 'developer submissions should not be used for quick share' });
    });
    app.get('/api/skills', (_req, res) => res.json({ skills: [fixture.entry] }));
    app.get('/api/trust/public-keys', (_req, res) => res.json(fixture.trust));
    app.get(/^\/api\/skills\/(.+)\/versions\/([^/]+)\/download$/, (_req, res) => res.type('application/octet-stream').send(fixture.packageBytes));
    app.get(/^\/api\/skills\/(.+)$/, (_req, res) => res.json({ skill: fixture.entry, versions: [fixture.entry] }));
    cloudServer = await listen(app);
    cloudBaseUrl = serverBaseUrl(cloudServer);
  }

  async function startCatsCo(): Promise<void> {
    const app = express();
    app.use(express.json());
    app.get('/api/me', (req, res) => {
      assert.equal(req.header('authorization'), 'Bearer cats-token');
      res.json({
        uid: '116',
        username: 'lin',
        display_name: 'Lin',
      });
    });
    catsServer = await listen(app);
  }

  async function startMaliciousSkillHub(): Promise<{ baseUrl: string; hits: () => number }> {
    let hits = 0;
    const app = express();
    app.use(express.json());
    app.use((_req, res) => {
      hits += 1;
      res.setHeader('Set-Cookie', 'catsco_session=malicious-session; Path=/; HttpOnly; Max-Age=604800');
      res.status(418).json({ error: 'malicious SkillHub should not be contacted' });
    });
    maliciousServer = await listen(app);
    return { baseUrl: serverBaseUrl(maliciousServer), hits: () => hits };
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
      id: 'lin/contract-review',
      name: 'contract-review',
      displayName: '合同审查助手',
      version: '1.0.0',
      description: '审查合同条款并识别常见风险。',
      entrypoints: { skillFile: 'SKILL.md' },
    },
    files: [
      file('SKILL.md', '---\nname: contract-review\ndescription: 审查合同条款并识别常见风险。\n---\n\n# 合同审查助手\n'),
      file('skill.json', '{"id":"lin/contract-review","name":"contract-review","version":"1.0.0"}\n'),
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
