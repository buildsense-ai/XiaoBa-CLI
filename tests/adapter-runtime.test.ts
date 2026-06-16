import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createAdapterRuntime } from '../src/runtime/adapter-runtime';

describe('adapter runtime', () => {
  let testRoot: string;
  let originalCwd: string;
  let originalProfilePath: string | undefined;
  let originalSkillsEnv: string | undefined;

  beforeEach(() => {
    originalCwd = process.cwd();
    originalProfilePath = process.env.XIAOBA_RUNTIME_PROFILE_PATH;
    originalSkillsEnv = process.env.XIAOBA_SKILLS_DIR;
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-adapter-runtime-'));
    process.chdir(testRoot);
    process.env.XIAOBA_RUNTIME_PROFILE_PATH = path.join(testRoot, 'missing-runtime-profile.json');
    process.env.XIAOBA_SKILLS_DIR = path.join(testRoot, 'skills');
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalProfilePath === undefined) {
      delete process.env.XIAOBA_RUNTIME_PROFILE_PATH;
    } else {
      process.env.XIAOBA_RUNTIME_PROFILE_PATH = originalProfilePath;
    }
    if (originalSkillsEnv === undefined) {
      delete process.env.XIAOBA_SKILLS_DIR;
    } else {
      process.env.XIAOBA_SKILLS_DIR = originalSkillsEnv;
    }
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('creates services and session manager options for adapters', () => {
    writeTestSkill('adapter-runtime-demo');
    const runtime = createAdapterRuntime({
      surface: 'feishu',
      sessionTTL: 1234,
    });
    const expectedWorkingDirectory = fs.realpathSync(testRoot);

    assert.equal(runtime.profile.surface, 'feishu');
    assert.equal(runtime.profile.workingDirectory, expectedWorkingDirectory);
    assert.equal((runtime.services.toolManager as any).workingDirectory, expectedWorkingDirectory);
    assert.deepStrictEqual(runtime.services.skillManager.getAllSkills(), []);
    assert.equal(runtime.sessionManagerOptions.ttl, 1234);
    assert.ok(runtime.sessionManagerOptions.systemPromptProviderFactory);
  });

  test('uses runtime profile file while keeping adapter surface authoritative', () => {
    const profilePath = path.join(testRoot, 'runtime-profile.json');
    const workspace = path.join(testRoot, 'workspace');
    fs.writeFileSync(profilePath, JSON.stringify({
      schemaVersion: 1,
      profile: {
        displayName: 'Adapter Profile Bot',
        surface: 'catscompany',
        workingDirectory: 'workspace',
        tools: {
          enabled: ['read_file'],
        },
      },
    }), 'utf-8');
    process.env.XIAOBA_RUNTIME_PROFILE_PATH = profilePath;

    const runtime = createAdapterRuntime({
      surface: 'feishu',
    });

    assert.equal(runtime.profile.surface, 'feishu');
    assert.equal(runtime.profile.displayName, 'Adapter Profile Bot');
    assert.equal(runtime.profile.workingDirectory, workspace);
    assert.deepStrictEqual(
      runtime.services.toolManager.getToolDefinitions().map(definition => definition.name),
      ['read_file'],
    );
  });

  test('fixed prompt mode snapshots identity and workingDirectory immediately', async () => {
    const runtime = createAdapterRuntime({
      surface: 'feishu',
      promptSnapshotMode: 'fixed',
    });
    runtime.profile.prompt.displayName = 'Late Feishu Name';
    runtime.profile.workingDirectory = path.join(testRoot, 'mutated');

    const provider = runtime.sessionManagerOptions.systemPromptProviderFactory?.('user:demo');
    assert.ok(provider);
    const prompt = await provider();

    assert.doesNotMatch(prompt, /Late Feishu Name/);
    assert.match(prompt, /Current directory is provided in a transient message/);
    assert.doesNotMatch(prompt.replace(/\\/g, '/'), /mutated/);
  });

  test('mutable identity mode reads latest displayName without concrete workingDirectory prompt', async () => {
    const runtime = createAdapterRuntime({
      surface: 'catscompany',
      promptSnapshotMode: 'mutable-identity',
    });
    runtime.profile.prompt.displayName = 'Cats Runtime Bot';
    runtime.profile.workingDirectory = path.join(testRoot, 'mutated');

    const provider = runtime.sessionManagerOptions.systemPromptProviderFactory?.('cc_user:demo');
    assert.ok(provider);
    const prompt = await provider();

    assert.match(prompt, /你在这个平台上的名字是：Cats Runtime Bot/);
    assert.match(prompt, /Current directory is provided in a transient message/);
    assert.doesNotMatch(prompt.replace(/\\/g, '/'), /mutated/);
  });

  test('exposes adapter skill loading lifecycle with warning and fail-fast modes', async () => {
    const warnRuntime = createAdapterRuntime({
      surface: 'feishu',
    });
    (warnRuntime.services.skillManager as any).loadSkills = async () => {
      throw new Error('warn mode failure');
    };

    await warnRuntime.loadSkills();

    const failFastRuntime = createAdapterRuntime({
      surface: 'weixin',
      skillLoadMode: 'fail-fast',
    });
    (failFastRuntime.services.skillManager as any).loadSkills = async () => {
      throw new Error('fail fast failure');
    };

    await assert.rejects(
      () => failFastRuntime.loadSkills(),
      /fail fast failure/,
    );
  });

  test('passes adapter skill loading lifecycle into session manager options', async () => {
    const warnRuntime = createAdapterRuntime({
      surface: 'feishu',
    });
    (warnRuntime.services.skillManager as any).loadSkills = async () => {
      throw new Error('warn reload failure');
    };

    await warnRuntime.sessionManagerOptions.skillReloadHandler?.();

    const failFastRuntime = createAdapterRuntime({
      surface: 'weixin',
      skillLoadMode: 'fail-fast',
    });
    (failFastRuntime.services.skillManager as any).loadSkills = async () => {
      throw new Error('fail reload failure');
    };

    await assert.rejects(
      () => failFastRuntime.sessionManagerOptions.skillReloadHandler?.(),
      /fail reload failure/,
    );
  });
});

function writeTestSkill(name: string): void {
  const skillDir = path.join(process.cwd(), 'skills', name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      'description: Adapter runtime test skill',
      '---',
      '',
      'Use this skill for adapter runtime tests.',
    ].join('\n'),
    'utf-8',
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
