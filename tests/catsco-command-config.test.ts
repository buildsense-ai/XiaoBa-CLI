import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveCatsCoCommandConfig } from '../src/commands/catscompany';
import { ChatConfig } from '../src/types';
import { createCatsCoLocalConfigService } from '../src/catscompany/local-config';

describe('CatsCo command config resolution', () => {
  let tempDir: string;
  let originalCwd: string;
  let originalRuntimeRoot: string | undefined;
  let originalUserDataDir: string | undefined;
  let originalBundledExecutablesDir: string | undefined;

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
    originalRuntimeRoot = process.env.XIAOBA_RUNTIME_ROOT;
    originalUserDataDir = process.env.XIAOBA_USER_DATA_DIR;
    originalBundledExecutablesDir = process.env.XIAOBA_BUNDLED_EXECUTABLES_DIR;
    delete process.env.XIAOBA_RUNTIME_ROOT;
    delete process.env.XIAOBA_USER_DATA_DIR;
    delete process.env.XIAOBA_BUNDLED_EXECUTABLES_DIR;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catsco-command-config-'));
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalRuntimeRoot === undefined) {
      delete process.env.XIAOBA_RUNTIME_ROOT;
    } else {
      process.env.XIAOBA_RUNTIME_ROOT = originalRuntimeRoot;
    }
    if (originalUserDataDir === undefined) delete process.env.XIAOBA_USER_DATA_DIR;
    else process.env.XIAOBA_USER_DATA_DIR = originalUserDataDir;
    if (originalBundledExecutablesDir === undefined) delete process.env.XIAOBA_BUNDLED_EXECUTABLES_DIR;
    else process.env.XIAOBA_BUNDLED_EXECUTABLES_DIR = originalBundledExecutablesDir;
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

  test('uses the explicit runtime data root for CatsCo binding and model resolution', () => {
    const runtimeRoot = path.join(tempDir, 'runtime-data');
    process.env.XIAOBA_RUNTIME_ROOT = runtimeRoot;
    saveConfirmedBinding(runtimeRoot);

    const resolved = resolveCatsCoCommandConfig({}, {
      CATSCO_USER_TOKEN: 'env-token',
      CATSCO_USER_UID: 'user-1',
      CATSCO_SERVER_URL: 'wss://catsco.example/v0/channels',
      CATSCO_API_KEY: 'catsco-key',
    });

    assert.deepEqual(resolved.missing, []);
    assert.equal(resolved.config?.apiKey, 'local-bot-key');
    assert.equal(resolved.config?.bodyId, 'body-local');
  });

  test('keeps first-class user data separate from bundled executables', () => {
    const runtimeDataRoot = path.join(tempDir, 'runtime-data');
    const bundledExecutablesDir = path.join(tempDir, 'bundled-executables');
    process.env.XIAOBA_USER_DATA_DIR = runtimeDataRoot;
    process.env.XIAOBA_BUNDLED_EXECUTABLES_DIR = bundledExecutablesDir;
    saveConfirmedBinding(runtimeDataRoot);

    const resolved = resolveCatsCoCommandConfig({}, {
      CATSCO_USER_TOKEN: 'env-token',
      CATSCO_USER_UID: 'user-1',
      CATSCO_SERVER_URL: 'wss://catsco.example/v0/channels',
      CATSCO_API_KEY: 'catsco-key',
      XIAOBA_USER_DATA_DIR: runtimeDataRoot,
      XIAOBA_BUNDLED_EXECUTABLES_DIR: bundledExecutablesDir,
    });

    assert.deepEqual(resolved.missing, []);
    assert.equal(resolved.config?.apiKey, 'local-bot-key');
    assert.equal(resolved.config?.bodyId, 'body-local');
    assert.equal(fs.existsSync(path.join(bundledExecutablesDir, '.xiaoba', 'catsco.json')), false);
  });

  function saveConfirmedBinding(runtimeRoot = tempDir): void {
    createCatsCoLocalConfigService({ runtimeRoot }).save({
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
