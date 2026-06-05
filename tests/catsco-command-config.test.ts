import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveCatsCoCommandConfig } from '../src/commands/catscompany';
import { resolveDeviceConnectorCommandConfig } from '../src/commands/device-connector';
import { ChatConfig } from '../src/types';
import { createCatsCoLocalConfigService } from '../src/catscompany/local-config';

describe('CatsCo command config resolution', () => {
  let tempDir: string;
  let originalCwd: string;

  const baseConfig: ChatConfig = {
    catscompany: {
      serverUrl: 'wss://legacy-config.example/v0/channels',
      apiKey: 'legacy-config-key',
      httpBaseUrl: 'https://legacy-config.example',
      sessionTTL: 123,
    },
  };

  beforeEach(() => {
    originalCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catsco-command-config-'));
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('uses CATSCO env endpoints with confirmed local body binding', () => {
    saveConfirmedBinding();
    const resolved = resolveCatsCoCommandConfig(baseConfig, {
      CATSCO_USER_TOKEN: 'env-token',
      CATSCO_USER_UID: 'user-1',
      CATSCO_SERVER_URL: 'wss://catsco.example/v0/channels',
      CATSCO_API_KEY: 'catsco-key',
      CATSCO_HTTP_BASE_URL: 'https://catsco.example',
      CATSCOMPANY_SERVER_URL: 'wss://legacy-env.example/v0/channels',
      CATSCOMPANY_API_KEY: 'legacy-env-key',
      CATSCOMPANY_HTTP_BASE_URL: 'https://legacy-env.example',
    });

    assert.deepEqual(resolved.missing, []);
    assert.equal(resolved.config?.serverUrl, 'wss://catsco.example/v0/channels');
    assert.equal(resolved.config?.apiKey, 'local-bot-key');
    assert.equal(resolved.config?.bodyId, 'body-local');
    assert.equal(resolved.config?.httpBaseUrl, 'https://catsco.example');
    assert.equal(resolved.config?.sessionTTL, 123);
  });

  test('falls back to CATSCOMPANY env endpoints with confirmed local body binding', () => {
    saveConfirmedBinding();
    const resolved = resolveCatsCoCommandConfig({}, {
      CATSCOMPANY_USER_TOKEN: 'legacy-env-token',
      CATSCOMPANY_USER_UID: 'user-1',
      CATSCOMPANY_SERVER_URL: 'wss://legacy-env.example/v0/channels',
      CATSCOMPANY_API_KEY: 'legacy-env-key',
    });

    assert.deepEqual(resolved.missing, []);
    assert.equal(resolved.config?.serverUrl, 'wss://legacy-env.example/v0/channels');
    assert.equal(resolved.config?.apiKey, 'local-bot-key');
    assert.equal(resolved.config?.bodyId, 'body-local');
  });

  test('does not start from legacy user config key without a confirmed body binding', () => {
    const resolved = resolveCatsCoCommandConfig(baseConfig, {});

    assert.deepEqual(resolved.missing, ['apiKey', 'bodyId']);
    assert.equal(resolved.config, undefined);
  });

  test('reports missing required connection values', () => {
    const resolved = resolveCatsCoCommandConfig({}, {
      CATSCO_HTTP_BASE_URL: 'https://catsco.example',
    });

    assert.deepEqual(resolved.missing, ['apiKey', 'bodyId']);
    assert.equal(resolved.config, undefined);
  });

  test('resolves lightweight device connector config from local enrollment', () => {
    createCatsCoLocalConfigService({ runtimeRoot: tempDir }).save({
      version: 1,
      endpoints: {
        httpBaseUrl: 'https://app.example',
        serverUrl: 'wss://app.example/v0/channels',
      },
      device: {
        deviceId: 'device-local',
        bodyId: 'device-local',
        installationId: 'install-local',
      },
      deviceConnector: {
        token: 'device-token',
        ownerUid: 'usr7',
        deviceId: 'device-local',
        installationId: 'install-local',
        capabilities: ['read_file', 'glob'],
      },
    });

    const resolved = resolveDeviceConnectorCommandConfig({}, {}, {});

    assert.deepEqual(resolved.missing, []);
    assert.equal(resolved.config?.authMode, 'device_connector');
    assert.equal(resolved.config?.connectorToken, 'device-token');
    assert.equal(resolved.config?.bodyId, 'device-local');
    assert.equal(resolved.config?.installationId, 'install-local');
    assert.deepEqual(resolved.config?.capabilities, ['read_file', 'glob']);
  });

  test('keeps saved device connector capabilities as the startup ceiling', () => {
    createCatsCoLocalConfigService({ runtimeRoot: tempDir }).save({
      version: 1,
      endpoints: {
        httpBaseUrl: 'https://app.example',
        serverUrl: 'wss://app.example/v0/channels',
      },
      device: {
        deviceId: 'device-local',
        bodyId: 'device-local',
        installationId: 'install-local',
      },
      deviceConnector: {
        token: 'device-token',
        ownerUid: 'usr7',
        deviceId: 'device-local',
        installationId: 'install-local',
        capabilities: ['read_file', 'glob', 'grep'],
      },
    });

    const resolved = resolveDeviceConnectorCommandConfig({}, {}, {
      allowWrite: true,
      allowShell: true,
      capability: ['read_file', 'write_file', 'execute_shell'],
    });

    assert.deepEqual(resolved.missing, []);
    assert.deepEqual(resolved.config?.capabilities, ['read_file', 'glob', 'grep']);
    assert.equal(resolved.config?.allowWriteFile, false);
    assert.equal(resolved.config?.allowShell, false);
  });

  function saveConfirmedBinding(): void {
    createCatsCoLocalConfigService({ runtimeRoot: tempDir }).save({
      version: 1,
      endpoints: {
        httpBaseUrl: 'https://local.example',
        serverUrl: 'wss://local.example/v0/channels',
      },
      account: {
        token: 'local-token',
        uid: 'user-1',
      },
      currentBot: {
        uid: 'bot-local',
        name: 'Local Bot',
        username: 'catsco_user_1',
        apiKey: 'local-bot-key',
        boundByUserUid: 'user-1',
        bindingSource: 'test',
      },
      device: {
        deviceId: 'body-local',
        bodyId: 'body-local',
        installationId: 'body-local',
      },
    });
  }
});
