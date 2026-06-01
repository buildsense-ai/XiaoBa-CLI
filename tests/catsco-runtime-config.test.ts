import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createCatsCoLocalConfigService } from '../src/catscompany/local-config';
import { resolveCatsCoRuntimeConfig } from '../src/catscompany/runtime-config';

describe('CatsCo runtime config resolver', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catsco-runtime-config-'));
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('uses confirmed local bot while env account and endpoints override stale local account data', () => {
    const service = createCatsCoLocalConfigService({ runtimeRoot: tempDir, env: {} as NodeJS.ProcessEnv });
    service.save({
      version: 1,
      endpoints: {
        httpBaseUrl: 'https://typed.example',
        serverUrl: 'wss://typed.example/v0/channels',
      },
      account: {
        token: 'typed-user-token',
        uid: 'user-typed',
      },
      currentBot: {
        uid: 'bot-typed',
        name: 'Typed Bot',
        apiKey: 'typed-api-key',
        boundByUserUid: 'user-typed',
        bindingSource: 'test',
      },
      device: {
        deviceId: 'device-typed',
        bodyId: 'body-typed',
        installationId: 'install-typed',
      },
    });

    const resolved = resolveCatsCoRuntimeConfig({
      runtimeRoot: tempDir,
      env: {
        CATSCO_USER_TOKEN: 'env-user-token',
        CATSCO_USER_UID: 'user-typed',
        CATSCO_SERVER_URL: 'wss://env.example/v0/channels',
        CATSCO_HTTP_BASE_URL: 'https://env.example',
        CATSCO_API_KEY: 'env-api-key',
        CATSCO_BOT_UID: 'bot-env',
      },
    });

    assert.equal(resolved.connector?.serverUrl, 'wss://env.example/v0/channels');
    assert.equal(resolved.connector?.httpBaseUrl, 'https://env.example');
    assert.equal(resolved.connector?.apiKey, 'typed-api-key');
    assert.equal(resolved.connector?.bodyId, 'body-typed');
    assert.equal(resolved.connector?.installationId, 'install-typed');
    assert.equal(resolved.auth.token, 'env-user-token');
    assert.equal(resolved.auth.uid, 'user-typed');
    assert.equal(resolved.auth.botUid, 'bot-typed');
    assert.equal(resolved.envOverlay.CATSCO_API_KEY, 'typed-api-key');
    assert.equal(resolved.envOverlay.CATSCOMPANY_BODY_ID, 'body-typed');
    assert.deepStrictEqual(resolved.conflicts.map(conflict => conflict.field).sort(), [
      'apiKey',
      'botUid',
      'httpBaseUrl',
      'serverUrl',
    ].sort());
    if (process.platform !== 'win32') {
      const configPath = path.join(tempDir, '.xiaoba', 'catsco.json');
      assert.equal((fs.statSync(path.dirname(configPath)).mode & 0o777), 0o700);
      assert.equal((fs.statSync(configPath).mode & 0o777), 0o600);
    }
  });

  test('ignores stale local bot binding when the active account uid changed', () => {
    const service = createCatsCoLocalConfigService({ runtimeRoot: tempDir, env: {} as NodeJS.ProcessEnv });
    service.save({
      version: 1,
      endpoints: {
        httpBaseUrl: 'https://typed.example',
        serverUrl: 'wss://typed.example/v0/channels',
      },
      account: {
        token: 'old-user-token',
        uid: 'old-user',
      },
      currentBot: {
        uid: 'old-bot',
        name: 'Old Bot',
        apiKey: 'old-api-key',
        boundByUserUid: 'old-user',
        bindingSource: 'test',
      },
      device: {
        deviceId: 'device-typed',
        bodyId: 'body-typed',
        installationId: 'install-typed',
      },
    });

    const resolved = resolveCatsCoRuntimeConfig({
      runtimeRoot: tempDir,
      env: {
        CATSCO_USER_TOKEN: 'new-user-token',
        CATSCO_USER_UID: 'new-user',
        CATSCO_SERVER_URL: 'wss://env.example/v0/channels',
        CATSCO_HTTP_BASE_URL: 'https://env.example',
      },
    });

    assert.equal(resolved.accountConnected, true);
    assert.equal(resolved.bodyConfigured, false);
    assert.equal(resolved.chatReady, false);
    assert.equal(resolved.auth.token, 'new-user-token');
    assert.equal(resolved.auth.uid, 'new-user');
    assert.equal(resolved.auth.botUid, undefined);
    assert.equal(resolved.auth.apiKey, undefined);
    assert.equal(resolved.connector, undefined);
    assert.equal(resolved.missing.includes('apiKey'), true);
    assert.equal(resolved.unconfirmedBotBinding, true);
    assert.equal(resolved.envOverlay.CATSCO_API_KEY, undefined);
  });

  test('upgrades legacy app.catsco.cc HTTP endpoint to HTTPS', () => {
    const service = createCatsCoLocalConfigService({ runtimeRoot: tempDir, env: {} as NodeJS.ProcessEnv });
    service.save({
      version: 1,
      endpoints: {
        httpBaseUrl: 'http://app.catsco.cc',
        serverUrl: 'wss://app.catsco.cc/v0/channels',
      },
      account: {
        token: 'user-token',
        uid: 'user-1',
      },
      currentBot: {
        uid: 'bot-1',
        name: 'Bot',
        apiKey: 'bot-key',
        boundByUserUid: 'user-1',
        bindingSource: 'test',
      },
      device: {
        deviceId: 'device-1',
        bodyId: 'body-1',
        installationId: 'install-1',
      },
    });

    const resolved = resolveCatsCoRuntimeConfig({
      runtimeRoot: tempDir,
      env: {
        CATSCOMPANY_HTTP_BASE_URL: 'http://app.catsco.cc',
      },
    });

    assert.equal(resolved.auth.httpBaseUrl, 'https://app.catsco.cc');
    assert.equal(resolved.connector?.httpBaseUrl, 'https://app.catsco.cc');
    assert.equal(resolved.envOverlay.CATSCO_HTTP_BASE_URL, 'https://app.catsco.cc');
  });

  test('does not start from legacy ChatConfig without a confirmed body binding', () => {
    const resolved = resolveCatsCoRuntimeConfig({
      runtimeRoot: tempDir,
      env: {},
      config: {
        catscompany: {
          serverUrl: 'wss://legacy-config.example/v0/channels',
          apiKey: 'legacy-config-key',
          httpBaseUrl: 'https://legacy-config.example',
          sessionTTL: 77,
        },
      },
    });

    assert.deepStrictEqual(resolved.missing, ['apiKey', 'bodyId']);
    assert.equal(resolved.connector, undefined);
    assert.equal(resolved.auth.serverUrl, 'wss://legacy-config.example/v0/channels');
    assert.equal(resolved.auth.apiKey, undefined);
    assert.equal(resolved.auth.httpBaseUrl, 'https://legacy-config.example');
  });

  test('treats typed default endpoints as explicit values over legacy ChatConfig', () => {
    const service = createCatsCoLocalConfigService({ runtimeRoot: tempDir, env: {} as NodeJS.ProcessEnv });
    service.save({
      version: 1,
      endpoints: {
        httpBaseUrl: 'https://app.catsco.cc',
        serverUrl: 'wss://app.catsco.cc/v0/channels',
      },
      currentBot: {
        uid: 'bot-default',
        name: 'Default Bot',
        apiKey: 'typed-default-key',
        boundByUserUid: 'user-default',
        bindingSource: 'test',
      },
      account: {
        token: 'token-default',
        uid: 'user-default',
      },
      device: {
        deviceId: 'device-default',
        bodyId: 'body-default',
        installationId: 'install-default',
      },
    });

    const resolved = resolveCatsCoRuntimeConfig({
      runtimeRoot: tempDir,
      env: {},
      config: {
        catscompany: {
          serverUrl: 'wss://legacy-config.example/v0/channels',
          httpBaseUrl: 'https://legacy-config.example',
          apiKey: 'legacy-key',
        },
      },
    });

    assert.equal(resolved.connector?.serverUrl, 'wss://app.catsco.cc/v0/channels');
    assert.equal(resolved.connector?.httpBaseUrl, 'https://app.catsco.cc');
    assert.equal(resolved.connector?.apiKey, 'typed-default-key');
  });

  test('does not treat env-only bot credentials as confirmed body binding', () => {
    const resolved = resolveCatsCoRuntimeConfig({
      runtimeRoot: tempDir,
      env: {
        CATSCO_SERVER_URL: 'wss://env.example/v0/channels',
        CATSCO_HTTP_BASE_URL: 'https://env.example',
        CATSCO_USER_TOKEN: 'env-user-token',
        CATSCO_USER_UID: 'user-env',
        CATSCO_BOT_UID: 'bot-env',
        CATSCO_API_KEY: 'env-api-key',
      },
    });

    assert.equal(resolved.accountConnected, true);
    assert.equal(resolved.connectorReady, false);
    assert.equal(resolved.bodyConfigured, false);
    assert.equal(resolved.chatReady, false);
    assert.equal(resolved.unconfirmedBotBinding, true);
    assert.equal(resolved.auth.botUid, undefined);
    assert.equal(resolved.envOverlay.CATSCO_API_KEY, undefined);
    assert.equal(resolved.envOverlay.CATSCO_BOT_UID, undefined);
  });
});
