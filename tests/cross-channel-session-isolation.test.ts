import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describe('cross-channel session isolation', () => {
  let testRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-cross-channel-session-'));
    process.chdir(testRoot);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('same raw user id uses separate session files and subagent callbacks per channel', async () => {
    const { SessionStore, SubAgentManager, createSessionRoute } = loadModules();
    const store = SessionStore.getInstance();
    const feishu = createSessionRoute({
      source: 'feishu',
      topicType: 'p2p',
      topicId: 'shared',
      actorUserId: 'shared',
      identityTrust: 'legacy_context',
      legacySessionKey: 'user:shared',
    });
    const weixin = createSessionRoute({
      source: 'weixin',
      topicType: 'p2p',
      topicId: 'shared',
      actorUserId: 'shared',
      identityTrust: 'legacy_context',
      legacySessionKey: 'user:shared',
    });

    store.saveContext(feishu.sessionKey, [{ role: 'user', content: 'feishu history' }]);
    store.saveContext(weixin.sessionKey, [{ role: 'user', content: 'weixin history' }]);

    assert.deepEqual(store.loadContext(feishu.sessionKey).map((message: any) => message.content), ['feishu history']);
    assert.deepEqual(store.loadContext(weixin.sessionKey).map((message: any) => message.content), ['weixin history']);
    assert.notEqual(feishu.sessionKey, weixin.sessionKey);

    const delivered: string[] = [];
    const manager = SubAgentManager.getInstance();
    manager.registerPlatformCallbacks(feishu.sessionKey, {
      injectMessage: async text => { delivered.push(`feishu:${text}`); },
    });
    manager.registerPlatformCallbacks(weixin.sessionKey, {
      injectMessage: async text => { delivered.push(`weixin:${text}`); },
    });

    try {
      await (manager as any).platformCallbacks.get(feishu.sessionKey).injectMessage('done');
      await (manager as any).platformCallbacks.get(weixin.sessionKey).injectMessage('done');
      assert.deepEqual(delivered, ['feishu:done', 'weixin:done']);
    } finally {
      manager.unregisterPlatformCallbacks(feishu.sessionKey);
      manager.unregisterPlatformCallbacks(weixin.sessionKey);
    }
  });
});

function loadModules(): any {
  for (const modulePath of [
    '../src/utils/session-store',
    '../src/core/session-router',
    '../src/core/sub-agent-manager',
  ]) {
    delete require.cache[require.resolve(modulePath)];
  }
  return {
    SessionStore: require('../src/utils/session-store').SessionStore,
    SubAgentManager: require('../src/core/sub-agent-manager').SubAgentManager,
    createSessionRoute: require('../src/core/session-router').createSessionRoute,
  };
}
