import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createCatsCoLocalConfigService } from '../src/catscompany/local-config';
import { resolveCatsCoRuntimeConfig } from '../src/catscompany/runtime-config';

describe('CatsCo endpoint family preference', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catsco-endpoint-pref-'));
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function seedBoundRuntime(): void {
    const service = createCatsCoLocalConfigService({ runtimeRoot: tempDir, env: {} as NodeJS.ProcessEnv });
    service.save({
      version: 1,
      endpoints: {
        httpBaseUrl: 'https://app.catsco.cc',
        serverUrl: 'wss://app.catsco.cc/v0/channels',
      },
      account: { token: 'token', uid: 'user-1' },
      currentBot: {
        uid: 'bot-1',
        name: 'Bot',
        apiKey: 'api-key',
        boundByUserUid: 'user-1',
        bindingSource: 'test',
      },
      device: { deviceId: 'device-1', bodyId: 'body-1', installationId: 'install-1' },
    });
  }

  test('records the last working endpoint family without touching configured endpoints', () => {
    const service = createCatsCoLocalConfigService({ runtimeRoot: tempDir, env: {} as NodeJS.ProcessEnv });
    service.save({
      version: 1,
      endpoints: {
        httpBaseUrl: 'https://app.catsco.cc',
        serverUrl: 'wss://app.catsco.cc/v0/channels',
      },
    });

    service.recordEndpointFamily('cn');
    let config = service.load();
    assert.equal(config.endpoints?.preferredFamily, 'cn');
    assert.equal(config.endpoints?.httpBaseUrl, 'https://app.catsco.cc');
    assert.equal(config.endpoints?.serverUrl, 'wss://app.catsco.cc/v0/channels');

    service.recordEndpointFamily('cc');
    config = service.load();
    assert.equal(config.endpoints?.preferredFamily, 'cc');
  });

  test('prefers the remembered family when resolving the connector', () => {
    seedBoundRuntime();
    const service = createCatsCoLocalConfigService({ runtimeRoot: tempDir, env: {} as NodeJS.ProcessEnv });
    service.recordEndpointFamily('cn');

    const resolved = resolveCatsCoRuntimeConfig({ runtimeRoot: tempDir, env: {} as NodeJS.ProcessEnv });

    assert.equal(resolved.connector?.preferredDomainFamily, 'cn');
    assert.equal(resolved.connector?.serverUrl, 'wss://app.catsco.cc/v0/channels');
    assert.equal(typeof resolved.connector?.onEndpointReady, 'function');
  });

  test('onEndpointReady records only supported CatsCo families', () => {
    seedBoundRuntime();
    const resolved = resolveCatsCoRuntimeConfig({ runtimeRoot: tempDir, env: {} as NodeJS.ProcessEnv });

    resolved.connector?.onEndpointReady?.('wss://app.catsco.cn/v0/channels');
    let config = createCatsCoLocalConfigService({ runtimeRoot: tempDir, env: {} as NodeJS.ProcessEnv }).load();
    assert.equal(config.endpoints?.preferredFamily, 'cn');

    resolved.connector?.onEndpointReady?.('wss://custom.example/v0/channels');
    config = createCatsCoLocalConfigService({ runtimeRoot: tempDir, env: {} as NodeJS.ProcessEnv }).load();
    assert.equal(config.endpoints?.preferredFamily, 'cn');
  });
});
