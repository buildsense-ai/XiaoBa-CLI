import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveCatsCoCommandConfig } from '../src/commands/catscompany';
import { createCatsCoLocalConfigService } from '../src/catscompany/local-config';
import { ChatConfig } from '../src/types';

describe('CatsCo command config resolution', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catsco-command-config-'));
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  const baseConfig: ChatConfig = {
    catscompany: {
      serverUrl: 'wss://legacy-config.example/v0/channels',
      apiKey: 'legacy-config-key',
      httpBaseUrl: 'https://legacy-config.example',
      sessionTTL: 123,
    },
  };

  function saveBoundLocalConfig(input: {
    endpoints?: { serverUrl?: string; httpBaseUrl?: string };
    apiKey?: string;
  } = {}): void {
    createCatsCoLocalConfigService({ runtimeRoot: tempDir, env: {} as NodeJS.ProcessEnv }).save({
      version: 1,
      ...(input.endpoints && { endpoints: input.endpoints }),
      account: {
        token: 'typed-user-token',
        uid: 'user-typed',
      },
      currentBot: {
        uid: 'bot-typed',
        name: 'Typed Bot',
        apiKey: input.apiKey || 'typed-api-key',
        boundByUserUid: 'user-typed',
        bindingSource: 'test',
      },
      device: {
        deviceId: 'device-typed',
        bodyId: 'body-typed',
        installationId: 'install-typed',
      },
    });
  }

  test('uses CATSCO env endpoints with a confirmed typed bot body', () => {
    saveBoundLocalConfig();
    const resolved = resolveCatsCoCommandConfig(baseConfig, {
      XIAOBA_RUNTIME_ROOT: tempDir,
      CATSCO_SERVER_URL: 'wss://catsco.example/v0/channels',
      CATSCO_HTTP_BASE_URL: 'https://catsco.example',
      CATSCOMPANY_SERVER_URL: 'wss://legacy-env.example/v0/channels',
      CATSCOMPANY_HTTP_BASE_URL: 'https://legacy-env.example',
    });

    assert.deepEqual(resolved.missing, []);
    assert.equal(resolved.config?.serverUrl, 'wss://catsco.example/v0/channels');
    assert.equal(resolved.config?.apiKey, 'typed-api-key');
    assert.equal(resolved.config?.bodyId, 'body-typed');
    assert.equal(resolved.config?.httpBaseUrl, 'https://catsco.example');
    assert.equal(resolved.config?.sessionTTL, 123);
  });

  test('falls back to CATSCOMPANY env aliases with a confirmed typed bot body', () => {
    saveBoundLocalConfig();
    const resolved = resolveCatsCoCommandConfig({}, {
      XIAOBA_RUNTIME_ROOT: tempDir,
      CATSCOMPANY_SERVER_URL: 'wss://legacy-env.example/v0/channels',
    });

    assert.deepEqual(resolved.missing, []);
    assert.equal(resolved.config?.serverUrl, 'wss://legacy-env.example/v0/channels');
    assert.equal(resolved.config?.apiKey, 'typed-api-key');
  });

  test('falls back to legacy user config endpoint with a confirmed typed bot body', () => {
    saveBoundLocalConfig();
    const resolved = resolveCatsCoCommandConfig(baseConfig, {
      XIAOBA_RUNTIME_ROOT: tempDir,
    });

    assert.deepEqual(resolved.missing, []);
    assert.equal(resolved.config?.serverUrl, 'wss://legacy-config.example/v0/channels');
    assert.equal(resolved.config?.apiKey, 'typed-api-key');
  });

  test('reports missing required connection values', () => {
    const resolved = resolveCatsCoCommandConfig({}, {
      XIAOBA_RUNTIME_ROOT: tempDir,
      CATSCO_HTTP_BASE_URL: 'https://catsco.example',
    });

    assert.deepEqual(resolved.missing.sort(), ['apiKey', 'bodyId'].sort());
    assert.equal(resolved.config, undefined);
  });

  test('prefers typed CatsCo local config over conflicting env aliases', () => {
    saveBoundLocalConfig({
      endpoints: {
        serverUrl: 'wss://typed.example/v0/channels',
        httpBaseUrl: 'https://typed.example',
      },
    });
    const resolved = resolveCatsCoCommandConfig({}, {
      XIAOBA_RUNTIME_ROOT: tempDir,
      CATSCO_SERVER_URL: 'wss://env.example/v0/channels',
      CATSCO_HTTP_BASE_URL: 'https://env.example',
      CATSCO_API_KEY: 'env-api-key',
    });

    assert.deepEqual(resolved.missing, []);
    assert.equal(resolved.config?.serverUrl, 'wss://typed.example/v0/channels');
    assert.equal(resolved.config?.httpBaseUrl, 'https://typed.example');
    assert.equal(resolved.config?.apiKey, 'typed-api-key');
  });
});
