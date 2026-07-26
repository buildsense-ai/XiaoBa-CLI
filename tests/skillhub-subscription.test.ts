import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import { createServer } from 'http';
import * as os from 'os';
import * as path from 'path';
import { SkillHubService } from '../src/skillhub/service';
import {
  claimSkillHubPackageOwnership,
  installVerifiedSkillHubPackage,
  SkillHubInstallError,
  uninstallSkillHubPackage,
} from '../src/skillhub/package-installer';
import { LocalUserSkillSubscriptionStore } from '../src/skillhub/subscription-store';
import { SkillHubSubscriptionService } from '../src/skillhub/subscription-service';
import type { SkillHubInstallResult, SkillHubUser, UserSkillSubscription } from '../src/skillhub/types';
import { SkillHubTool } from '../src/tools/skillhub-tool';
import { ToolManager } from '../src/tools/tool-manager';
import type { ExecutionScope, ScopedLocalDeviceGrant } from '../src/types/session-identity';
import type { ToolExecutionContext } from '../src/types/tool';

describe('SkillHub user subscriptions', () => {
  let testRoot: string;
  let originalSkillsDir: string | undefined;
  let originalUserDataDir: string | undefined;
  let originalCatsCoToken: string | undefined;
  let originalCatsCoApiKey: string | undefined;
  let originalCatsCompanyToken: string | undefined;
  let originalCatsCompanyApiKey: string | undefined;
  let originalCatsCoBaseUrl: string | undefined;

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-skillhub-subscriptions-'));
    originalSkillsDir = process.env.XIAOBA_SKILLS_DIR;
    originalUserDataDir = process.env.XIAOBA_USER_DATA_DIR;
    originalCatsCoToken = process.env.CATSCO_USER_TOKEN;
    originalCatsCoApiKey = process.env.CATSCO_API_KEY;
    originalCatsCompanyToken = process.env.CATSCOMPANY_USER_TOKEN;
    originalCatsCompanyApiKey = process.env.CATSCOMPANY_API_KEY;
    originalCatsCoBaseUrl = process.env.CATSCO_HTTP_BASE_URL;
    process.env.XIAOBA_SKILLS_DIR = path.join(testRoot, 'skills');
    process.env.XIAOBA_USER_DATA_DIR = testRoot;
    fs.mkdirSync(process.env.XIAOBA_SKILLS_DIR, { recursive: true });
  });

  afterEach(() => {
    if (originalSkillsDir === undefined) delete process.env.XIAOBA_SKILLS_DIR;
    else process.env.XIAOBA_SKILLS_DIR = originalSkillsDir;
    restoreEnv('XIAOBA_USER_DATA_DIR', originalUserDataDir);
    restoreEnv('CATSCO_USER_TOKEN', originalCatsCoToken);
    restoreEnv('CATSCO_API_KEY', originalCatsCoApiKey);
    restoreEnv('CATSCOMPANY_USER_TOKEN', originalCatsCompanyToken);
    restoreEnv('CATSCOMPANY_API_KEY', originalCatsCompanyApiKey);
    restoreEnv('CATSCO_HTTP_BASE_URL', originalCatsCoBaseUrl);
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  test('stores subscriptions independently for each SkillHub user', () => {
    const store = new LocalUserSkillSubscriptionStore(path.join(testRoot, 'subscriptions.json'));
    store.set('user-a', subscription('alice/ppt', 'ppt', '1.0.0'));
    store.set('user-b', subscription('bob/search', 'search', '2.0.0'));

    assert.deepEqual(store.list('user-a').map(item => item.skillId), ['alice/ppt']);
    assert.deepEqual(store.list('user-b').map(item => item.skillId), ['bob/search']);
    assert.equal(store.remove('user-a', 'alice/ppt'), true);
    assert.deepEqual(store.list('user-a'), []);
    assert.deepEqual(store.list('user-b').map(item => item.skillId), ['bob/search']);
  });

  test('migrates the prototype Agent buckets to the first authenticated SkillHub user', () => {
    const filePath = path.join(testRoot, 'subscriptions.json');
    fs.writeFileSync(filePath, JSON.stringify({
      schema: 'xiaoba.skillhub.subscriptions.v1',
      agents: {
        'agent-a': { 'alice/ppt': subscription('alice/ppt', 'ppt', '1.0.0') },
        'agent-b': { 'bob/search': subscription('bob/search', 'search', '2.0.0') },
      },
    }));
    const store = new LocalUserSkillSubscriptionStore(filePath);

    assert.deepEqual(store.list('skillhub-user').map(item => item.skillId), ['alice/ppt', 'bob/search']);
    const migrated = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(migrated.schema, 'xiaoba.skillhub.subscriptions.v2');
    assert.deepEqual(Object.keys(migrated.users), ['skillhub-user']);
    assert.equal('agents' in migrated, false);
  });

  test('resolves identity from the SkillHub session and auto-connects with the local CatsCo login', async t => {
    let exchangeBody: any;
    const server = createServer((request, response) => {
      if (request.method === 'GET' && request.url === '/api/auth/me') {
        if (!String(request.headers.cookie || '').includes('skillhub_session=test-session')) {
          response.writeHead(401, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error: 'login required' }));
          return;
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({
          user: skillHubUser('skillhub-user'),
          roles: ['user'],
          permissions: [],
        }));
        return;
      }
      if (request.method === 'POST' && request.url === '/api/auth/catsco-exchange') {
        const chunks: Buffer[] = [];
        request.on('data', chunk => chunks.push(Buffer.from(chunk)));
        request.on('end', () => {
          exchangeBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          response.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': 'skillhub_session=test-session; Path=/; HttpOnly',
          });
          response.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    process.env.CATSCO_USER_TOKEN = 'catsco-login-token';
    process.env.CATSCO_API_KEY = 'catsco-bot-key-that-must-not-win';
    process.env.CATSCO_HTTP_BASE_URL = 'https://catsco.example';

    const service = new SkillHubService({ baseUrl: `http://127.0.0.1:${address.port}` });
    const user = await service.requireAuthenticatedUser();

    assert.equal(user.id, 'skillhub-user');
    assert.equal(exchangeBody.token, 'catsco-login-token');
    assert.equal(exchangeBody.baseUrl, 'https://catsco.example');
  });

  test('uses runtime-local Skill state for a cloud Agent without contacting SkillHub auth', async () => {
    delete process.env.CATSCO_USER_TOKEN;
    delete process.env.CATSCOMPANY_USER_TOKEN;
    delete process.env.CATSCO_API_KEY;
    process.env.CATSCOMPANY_API_KEY = 'cc_420_cloud-agent-key';

    const service = new SkillHubService({ baseUrl: 'http://127.0.0.1:1' });
    const scope = await service.resolveSubscriptionScope();

    assert.deepEqual(scope, { kind: 'runtime' });
  });

  test('subscribe is idempotent and refreshes the same Skill to latest', async () => {
    const store = new LocalUserSkillSubscriptionStore(path.join(testRoot, 'subscriptions.json'));
    let version = '1.0.0';
    let action: SkillHubInstallResult['skill']['action'] = 'installed';
    const installCalls: Array<{ skillId: string; userId?: string; allowUpdate?: boolean }> = [];
    const gateway = {
      resolveSubscriptionScope: async () => ({ kind: 'user' as const, userId: 'user-a' }),
      install: async (skillId: string, _requested?: string, options?: { userId?: string; allowUpdate?: boolean }) => {
        installCalls.push({ skillId, ...options });
        return installResult(skillId, version, action);
      },
      uninstall: () => ({ removed: true, path: path.join(testRoot, 'skills', 'ppt') }),
    };
    const timestamps = [new Date('2026-07-14T01:00:00.000Z'), new Date('2026-07-14T02:00:00.000Z')];
    const service = new SkillHubSubscriptionService(gateway, store, () => timestamps.shift()!);

    const first = await service.subscribe('alice/ppt');
    version = '1.1.0';
    action = 'updated';
    const second = await service.subscribe('alice/ppt');

    assert.equal(first.action, 'installed');
    assert.equal(second.action, 'updated');
    assert.equal(second.subscription.resolvedVersion, '1.1.0');
    assert.equal(second.subscription.subscribedAt, '2026-07-14T01:00:00.000Z');
    assert.equal(second.subscription.updatedAt, '2026-07-14T02:00:00.000Z');
    assert.deepEqual(installCalls, [
      { skillId: 'alice/ppt', userId: 'user-a', allowUpdate: true },
      { skillId: 'alice/ppt', userId: 'user-a', allowUpdate: true },
    ]);
  });

  test('unsubscribe deletes the managed copy before removing the user subscription', async () => {
    const store = new LocalUserSkillSubscriptionStore(path.join(testRoot, 'subscriptions.json'));
    store.set('user-a', subscription('alice/ppt', 'ppt', '1.0.0'));
    const uninstallCalls: unknown[] = [];
    const gateway = {
      resolveSubscriptionScope: async () => ({ kind: 'user' as const, userId: 'user-a' }),
      install: async () => installResult('alice/ppt', '1.0.0', 'unchanged'),
      uninstall: (input: unknown) => {
        uninstallCalls.push(input);
        return { removed: true, path: path.join(testRoot, 'skills', 'ppt') };
      },
    };
    const service = new SkillHubSubscriptionService(gateway, store);

    const result = await service.unsubscribe('alice/ppt');

    assert.deepEqual(result, {
      scope: 'user',
      userId: 'user-a',
      skillId: 'alice/ppt',
      removed: true,
      subscriptionFound: true,
    });
    assert.deepEqual(uninstallCalls, [{ userId: 'user-a', skillId: 'alice/ppt', installName: 'ppt' }]);
    assert.deepEqual(store.list('user-a'), []);
  });

  test('runtime scope installs, lists, and removes Skills using only install markers', async () => {
    const storePath = path.join(testRoot, 'subscriptions.json');
    const store = new LocalUserSkillSubscriptionStore(storePath);
    const installCalls: unknown[] = [];
    const gateway = {
      resolveSubscriptionScope: async () => ({ kind: 'runtime' as const }),
      install: async (skillId: string, _requested?: string, options?: { userId?: string; allowUpdate?: boolean }) => {
        installCalls.push({ skillId, options });
        const installed = installVerifiedSkillHubPackage(
          packageOptions(skillId, 'ppt', '1.0.0', '# runtime', undefined),
        );
        return {
          ok: true as const,
          skill: installed,
          signingKeyId: 'signing-test',
          rootKeyId: 'root-test',
        };
      },
      uninstall: (input: { userId?: string; skillId: string; installName: string }) => (
        uninstallSkillHubPackage(input)
      ),
    };
    const service = new SkillHubSubscriptionService(
      gateway,
      store,
      () => new Date('2026-07-14T03:00:00.000Z'),
    );

    const added = await service.subscribe('alice/ppt');
    const listed = await service.list();

    assert.equal(added.scope, 'runtime');
    assert.equal(added.userId, undefined);
    assert.deepEqual(installCalls, [{
      skillId: 'alice/ppt',
      options: { allowUpdate: true },
    }]);
    assert.deepEqual(listed.subscriptions.map(item => item.skillId), ['alice/ppt']);
    assert.equal(fs.existsSync(storePath), false);

    const removed = await service.unsubscribe('alice/ppt');
    assert.deepEqual(removed, {
      scope: 'runtime',
      skillId: 'alice/ppt',
      removed: true,
      subscriptionFound: true,
    });
    assert.equal(fs.existsSync(path.join(testRoot, 'skills', 'ppt')), false);
    assert.equal(fs.existsSync(storePath), false);
  });

  test('verified installs write trusted markers, update same skill, and reject same-name strangers', () => {
    const first = installVerifiedSkillHubPackage(packageOptions('alice/ppt', 'ppt', '1.0.0', '# v1', 'user-a'));
    assert.equal(first.action, 'installed');
    const marker = JSON.parse(fs.readFileSync(path.join(first.path, '.xiaoba-skillhub-install.json'), 'utf8'));
    assert.equal(marker.userId, 'user-a');
    assert.equal(marker.skillId, 'alice/ppt');

    const unchanged = installVerifiedSkillHubPackage(packageOptions('alice/ppt', 'ppt', '1.0.0', '# v1', 'user-a'));
    assert.equal(unchanged.action, 'unchanged');

    const updated = installVerifiedSkillHubPackage(packageOptions('alice/ppt', 'ppt', '1.1.0', '# v2', 'user-a'));
    assert.equal(updated.action, 'updated');
    assert.match(fs.readFileSync(path.join(updated.path, 'SKILL.md'), 'utf8'), /# v2/);

    assert.throws(
      () => installVerifiedSkillHubPackage(packageOptions('mallory/ppt', 'ppt', '9.0.0', '# stranger', 'user-a')),
      (error: any) => error instanceof SkillHubInstallError && error.code === 'TARGET_CONFLICT',
    );
  });

  test('uninstall only removes the matching SkillHub user and Skill marker', () => {
    installVerifiedSkillHubPackage(packageOptions('alice/ppt', 'ppt', '1.0.0', '# v1', 'user-a'));

    assert.throws(
      () => uninstallSkillHubPackage({ userId: 'user-b', skillId: 'alice/ppt', installName: 'ppt' }),
      (error: any) => error instanceof SkillHubInstallError && error.code === 'USER_CONFLICT',
    );
    assert.equal(fs.existsSync(path.join(testRoot, 'skills', 'ppt')), true);

    const result = uninstallSkillHubPackage({ userId: 'user-a', skillId: 'alice/ppt', installName: 'ppt' });
    assert.equal(result.removed, true);
    assert.equal(fs.existsSync(path.join(testRoot, 'skills', 'ppt')), false);
  });

  test('claims legacy install markers for the authenticated SkillHub user', () => {
    const installed = installVerifiedSkillHubPackage(packageOptions('alice/ppt', 'ppt', '1.0.0', '# v1', 'old-user'));
    const markerPath = path.join(installed.path, '.xiaoba-skillhub-install.json');
    const legacyMarker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    delete legacyMarker.userId;
    legacyMarker.agentId = 'usr420';
    fs.writeFileSync(markerPath, JSON.stringify(legacyMarker, null, 2));

    assert.equal(claimSkillHubPackageOwnership({
      userId: 'skillhub-user',
      skillId: 'alice/ppt',
      installName: 'ppt',
    }), true);
    const claimed = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    assert.equal(claimed.userId, 'skillhub-user');
    assert.equal('agentId' in claimed, false);
  });

  test('Tool can browse and a non-owner CatsCo actor can subscribe without a confirmation step', async () => {
    const calls: string[] = [];
    const tool = new SkillHubTool(
      {
        search: async query => ({
          skills: [{
            skillId: 'alice/ppt',
            name: 'ppt',
            displayName: 'PPT Assistant',
            description: `matches ${query}`,
            latestVersion: '1.0.0',
            packageUrl: '/download',
            checksumSha256: 'abc',
            signature: { algorithm: 'ed25519', keyId: 'key', signature: 'sig' },
          }],
        }),
      },
      {
        list: async () => ({ scope: 'user', userId: 'skillhub-user', subscriptions: [] }),
        subscribe: async skillId => {
          calls.push(skillId);
          return { scope: 'user', userId: 'skillhub-user', action: 'installed', subscription: subscription(skillId, 'ppt', '1.0.0') };
        },
        unsubscribe: async skillId => ({ scope: 'user', userId: 'skillhub-user', skillId, removed: true, subscriptionFound: true }),
      },
    );

    const browse = await tool.execute({ action: 'search', query: 'slides' }, baseContext());
    assert.equal(browse.ok, true);
    assert.match(String(browse.ok && browse.content), /alice\/ppt/);

    const subscribed = await tool.execute({ action: 'subscribe', skillId: 'alice/ppt' }, catsCoContext('usr9'));
    assert.equal(subscribed.ok, true);
    assert.deepEqual(calls, ['alice/ppt']);
    assert.doesNotMatch(String(subscribed.ok && subscribed.content), /usr43/);
    assert.match(String(subscribed.ok && subscribed.content), /skillhub-user/);
  });

  test('Tool tells the Agent to serialize multiple subscription mutations', () => {
    const tool = new SkillHubTool();

    assert.match(tool.definition.description, /一次只调用一个 subscribe\/unsubscribe/);
    assert.match(tool.definition.description, /任一操作失败后停止/);
    assert.match(tool.definition.description, /不要并行或重试/);
    assert.match(tool.definition.description, /任何明确提出请求的用户/);
  });

  test('Tool allows a non-owner CatsCo actor to unsubscribe', async () => {
    let called = false;
    const tool = new SkillHubTool(
      { search: async () => ({ skills: [] }) },
      {
        list: async () => ({ scope: 'user', userId: 'skillhub-user', subscriptions: [] }),
        subscribe: async () => {
          called = true;
          return { scope: 'user', userId: 'skillhub-user', action: 'installed', subscription: subscription('alice/ppt', 'ppt', '1.0.0') };
        },
        unsubscribe: async skillId => {
          called = true;
          return { scope: 'user', userId: 'skillhub-user', skillId, removed: true, subscriptionFound: true };
        },
      },
    );
    const result = await tool.execute(
      { action: 'unsubscribe', skillId: 'alice/ppt' },
      catsCoContext('usr9'),
    );

    assert.equal(result.ok, true);
    assert.equal(called, true);
  });

  test('Tool rejects Skill mutations from an untrusted CatsCo actor', async () => {
    let called = false;
    const tool = mutationTrackingTool(() => {
      called = true;
    });

    const result = await tool.execute(
      { action: 'subscribe', skillId: 'alice/ppt' },
      catsCoContext('usr9', 'untrusted'),
    );

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.errorCode, 'PERMISSION_DENIED');
    assert.equal(called, false);
  });

  test('Tool rejects Skill mutations from a legacy CatsCo context', async () => {
    let called = false;
    const tool = mutationTrackingTool(() => {
      called = true;
    });

    const result = await tool.execute(
      { action: 'unsubscribe', skillId: 'alice/ppt' },
      catsCoContext('usr9', 'legacy_context'),
    );

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.errorCode, 'PERMISSION_DENIED');
    assert.equal(called, false);
  });

  test('ToolManager does not introduce a confirmation step for SkillHub operations', async () => {
    const manager = new ToolManager(testRoot, {}, { enabledToolNames: [] });
    let confirmations = 0;
    manager.registerTool({
      definition: {
        name: 'skillhub',
        description: 'test skillhub',
        parameters: { type: 'object', properties: {} },
      },
      execute: async () => ({ ok: true, content: 'skillhub ran' }),
    });

    const result = await manager.executeTool({
      id: 'skillhub-no-confirmation',
      type: 'function',
      function: { name: 'skillhub', arguments: '{}' },
    }, [], {
      permissionProfile: 'strict',
      confirmToolExecution: async () => {
        confirmations += 1;
        return false;
      },
    });

    assert.equal(result.ok, true);
    assert.equal(confirmations, 0);
  });
});

function subscription(skillId: string, installName: string, version: string): UserSkillSubscription {
  return {
    skillId,
    name: installName,
    installName,
    versionPolicy: 'latest',
    resolvedVersion: version,
    subscribedAt: '2026-07-14T00:00:00.000Z',
    updatedAt: '2026-07-14T00:00:00.000Z',
  };
}

function skillHubUser(id: string): SkillHubUser {
  return { id, email: `${id}@example.com`, displayName: id };
}

function installResult(
  skillId: string,
  version: string,
  action: SkillHubInstallResult['skill']['action'],
): SkillHubInstallResult {
  return {
    ok: true,
    skill: {
      skillId,
      name: 'ppt',
      installName: 'ppt',
      version,
      path: path.join(os.tmpdir(), 'skills', 'ppt'),
      action,
    },
    signingKeyId: 'signing-test',
    rootKeyId: 'root-test',
  };
}

function packageOptions(skillId: string, name: string, version: string, content: string, userId?: string): any {
  const encoded = Buffer.from(content).toString('base64');
  const checksum = `${skillId}:${version}:${content}`;
  return {
    userId,
    allowUpdate: true,
    registryEntry: {
      skillId,
      name,
      latestVersion: version,
      packageUrl: `/skills/${skillId}/${version}`,
      checksumSha256: checksum,
      signature: { algorithm: 'ed25519', keyId: 'signing-test', signature: 'sig' },
    },
    verification: {
      packageObject: {
        payload: {
          packageSchemaVersion: '1.0.0',
          manifest: { id: skillId, name, displayName: name, version, entrypoints: { skillFile: 'SKILL.md' } },
          files: [{ path: 'SKILL.md', size: content.length, sha256: checksum, contentBase64: encoded }],
        },
      },
      signingKey: { keyId: 'signing-test' },
      root: { keyId: 'root-test' },
    },
  };
}

function baseContext(): ToolExecutionContext {
  return { workingDirectory: testCwd(), conversationHistory: [] };
}

function mutationTrackingTool(onMutation: () => void): SkillHubTool {
  return new SkillHubTool(
    { search: async () => ({ skills: [] }) },
    {
      list: async () => ({ scope: 'runtime', subscriptions: [] }),
      subscribe: async skillId => {
        onMutation();
        return { scope: 'runtime', action: 'installed', subscription: subscription(skillId, 'ppt', '1.0.0') };
      },
      unsubscribe: async skillId => {
        onMutation();
        return { scope: 'runtime', skillId, removed: true, subscriptionFound: true };
      },
    },
  );
}

function catsCoContext(
  actorUserId = 'usr7',
  identityTrust: ExecutionScope['identityTrust'] = 'server_canonical',
): ToolExecutionContext {
  const scope: ExecutionScope = {
    source: 'catscompany',
    sessionKey: 'session:v2:catscompany:p2p:p2p_7_43:agent:usr43',
    topicId: 'p2p_7_43',
    topicType: 'p2p',
    actorUserId,
    agentId: 'usr43',
    agentBodyId: 'body-main',
    identityTrust,
    isTrusted: identityTrust === 'server_canonical',
  };
  const localDeviceGrant: ScopedLocalDeviceGrant = {
    kind: 'catscompany_body',
    source: 'catscompany',
    ownerUserId: 'usr7',
    bodyId: 'body-main',
    createdAt: Date.now(),
  };
  return {
    workingDirectory: testCwd(),
    conversationHistory: [],
    surface: 'catscompany',
    executionScope: scope,
    localDeviceGrant,
  };
}

function testCwd(): string {
  return process.env.XIAOBA_SKILLS_DIR || process.cwd();
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
