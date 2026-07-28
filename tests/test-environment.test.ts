import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import {
  buildIsolatedTestEnvironment,
  RUNTIME_WRITE_PATH_ENV_KEYS,
} from '../scripts/test-environment.mjs';

describe('test runner environment isolation', () => {
  test('removes every external runtime write path without mutating the source', () => {
    const source: Record<string, string> = {
      PATH: '/usr/bin',
      KEEP_ME: 'yes',
      DOTENV_CONFIG_PATH: '/production/.env',
    };
    for (const key of RUNTIME_WRITE_PATH_ENV_KEYS) {
      source[key] = `/production/${key.toLowerCase()}`;
    }

    const isolated = buildIsolatedTestEnvironment(source, {
      homeDir: '/tmp/xiaoba-test-home',
      tempDir: '/tmp/xiaoba-test-tmp',
      appRoot: '/workspace/xiaoba',
      dotenvPath: '/tmp/xiaoba-test-runner/.env',
    });

    for (const key of RUNTIME_WRITE_PATH_ENV_KEYS) {
      assert.equal(isolated[key], undefined, key);
      assert.ok(source[key], `source ${key} should remain unchanged`);
    }
    assert.equal(isolated.KEEP_ME, 'yes');
    assert.equal(isolated.HOME, '/tmp/xiaoba-test-home');
    assert.equal(isolated.USERPROFILE, '/tmp/xiaoba-test-home');
    assert.equal(isolated.TMPDIR, '/tmp/xiaoba-test-tmp');
    assert.equal(isolated.TMP, '/tmp/xiaoba-test-tmp');
    assert.equal(isolated.TEMP, '/tmp/xiaoba-test-tmp');
    assert.equal(isolated.XIAOBA_APP_ROOT, '/workspace/xiaoba');
    assert.equal(isolated.DOTENV_CONFIG_PATH, '/tmp/xiaoba-test-runner/.env');
    assert.equal(source.DOTENV_CONFIG_PATH, '/production/.env');
    assert.equal(isolated.NODE_ENV, 'test');
    assert.equal(isolated.XIAOBA_TEST_RUNNER, '1');
  });
});
