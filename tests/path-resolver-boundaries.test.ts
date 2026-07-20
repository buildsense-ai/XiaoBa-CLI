import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as os from 'node:os';
import * as path from 'node:path';
import { PathResolver } from '../src/utils/path-resolver';

describe('PathResolver runtime data boundary', () => {
  const testRoot = path.join(os.tmpdir(), 'xiaoba-path-boundary');

  test('bundled executables directory never becomes runtime data root', () => {
    const bundledExecutablesDir = path.join(testRoot, 'bundled-executables');
    const env = { XIAOBA_BUNDLED_EXECUTABLES_DIR: bundledExecutablesDir } as NodeJS.ProcessEnv;

    assert.equal(PathResolver.getRuntimeDataRoot(env, testRoot), path.resolve(testRoot));
  });

  test('explicit user data root wins over all compatibility roots', () => {
    const userDataRoot = path.join(testRoot, 'user-data');
    const env = {
      XIAOBA_USER_DATA_DIR: userDataRoot,
      CATSCO_USER_DATA_DIR: path.join(testRoot, 'catsco-data'),
      XIAOBA_RUNTIME_ROOT: path.join(testRoot, 'legacy-data'),
      XIAOBA_BUNDLED_EXECUTABLES_DIR: path.join(testRoot, 'bundled-executables'),
    } as NodeJS.ProcessEnv;

    assert.equal(PathResolver.getRuntimeDataRoot(env, testRoot), userDataRoot);
  });

  test('legacy runtime root remains a data-only compatibility input', () => {
    const legacyDataRoot = path.join(testRoot, 'legacy-data');
    const env = {
      XIAOBA_RUNTIME_ROOT: legacyDataRoot,
      XIAOBA_BUNDLED_EXECUTABLES_DIR: path.join(testRoot, 'bundled-executables'),
    } as NodeJS.ProcessEnv;

    assert.equal(PathResolver.getRuntimeDataRoot(env, testRoot), legacyDataRoot);
  });
});
