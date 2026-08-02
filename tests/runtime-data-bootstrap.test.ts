import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import { applyRuntimeDataOptionsFromArgv } from '../src/runtime/runtime-data-bootstrap';

describe('runtime data CLI bootstrap', () => {
  test('applies data root and profile before command modules load', () => {
    const env = {} as NodeJS.ProcessEnv;
    const cwd = path.resolve('/tmp/xiaoba-bootstrap');
    const result = applyRuntimeDataOptionsFromArgv([
      'node',
      'xiaoba',
      '--data-dir',
      './runtime',
      '--profile=cache-a',
      'dashboard',
    ], env, cwd);

    assert.equal(env.XIAOBA_USER_DATA_DIR, path.join(cwd, 'runtime'));
    assert.equal(env.XIAOBA_PROFILE, 'cache-a');
    assert.deepEqual(result, { dataDir: path.join(cwd, 'runtime'), profile: 'cache-a' });
  });

  test('rejects missing option values', () => {
    assert.throws(
      () => applyRuntimeDataOptionsFromArgv(['node', 'xiaoba', '--data-dir'], {} as NodeJS.ProcessEnv),
      /--data-dir requires a value/,
    );
  });
});
