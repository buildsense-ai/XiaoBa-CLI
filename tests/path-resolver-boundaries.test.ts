import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
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

  test('packaged Electron userData resolves to the active Skills directory', () => {
    const previousUserData = process.env.XIAOBA_USER_DATA_DIR;
    const previousSkills = process.env.XIAOBA_SKILLS_DIR;
    const userDataRoot = path.join(testRoot, 'packaged-user-data');
    try {
      process.env.XIAOBA_USER_DATA_DIR = userDataRoot;
      delete process.env.XIAOBA_SKILLS_DIR;
      assert.equal(PathResolver.getSkillsPath(), path.join(userDataRoot, 'skills'));
    } finally {
      if (previousUserData === undefined) delete process.env.XIAOBA_USER_DATA_DIR;
      else process.env.XIAOBA_USER_DATA_DIR = previousUserData;
      if (previousSkills === undefined) delete process.env.XIAOBA_SKILLS_DIR;
      else process.env.XIAOBA_SKILLS_DIR = previousSkills;
    }
  });

  test('legacy runtime root remains a data-only compatibility input', () => {
    const legacyDataRoot = path.join(testRoot, 'legacy-data');
    const env = {
      XIAOBA_RUNTIME_ROOT: legacyDataRoot,
      XIAOBA_BUNDLED_EXECUTABLES_DIR: path.join(testRoot, 'bundled-executables'),
    } as NodeJS.ProcessEnv;

    assert.equal(PathResolver.getRuntimeDataRoot(env, testRoot), legacyDataRoot);
  });

  test('Node tests refuse an explicit runtime root outside the OS temp directory', () => {
    const unsafeRoot = path.resolve(path.parse(testRoot).root, 'srv', 'catsco-agent');
    const env = {
      NODE_TEST_CONTEXT: 'child-v8',
      XIAOBA_USER_DATA_DIR: unsafeRoot,
    } as NodeJS.ProcessEnv;

    assert.throws(
      () => PathResolver.getRuntimeDataRoot(env, testRoot),
      /Refusing Node test runtime data root outside the OS temporary directory/,
    );
  });

  test('Node tests may use an explicit runtime root inside the OS temp directory', () => {
    const safeRoot = path.join(testRoot, 'isolated-runtime');
    const env = {
      NODE_TEST_CONTEXT: 'child-v8',
      XIAOBA_USER_DATA_DIR: safeRoot,
    } as NodeJS.ProcessEnv;

    assert.equal(PathResolver.getRuntimeDataRoot(env, testRoot), path.resolve(safeRoot));
  });

  test('skill discovery skips an excluded subtree before traversing it', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-skill-discovery-'));
    const generatedRoot = path.join(root, 'generated-distilled');
    try {
      fs.mkdirSync(path.join(root, 'manual'), { recursive: true });
      fs.mkdirSync(path.join(generatedRoot, 'capability'), { recursive: true });
      fs.writeFileSync(path.join(root, 'manual', 'SKILL.md'), '---\nname: manual\n---\n');
      fs.writeFileSync(path.join(generatedRoot, 'capability', 'SKILL.md'), '---\nname: generated\n---\n');

      const discovered = PathResolver.findSkillFiles(root, {
        shouldSkipDirectory: directoryPath => path.resolve(directoryPath) === path.resolve(generatedRoot),
      }).map(filePath => path.relative(root, filePath));

      assert.deepEqual(discovered, [path.join('manual', 'SKILL.md')]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
