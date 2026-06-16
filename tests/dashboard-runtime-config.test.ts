import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRuntimeConfigSnapshot } from '../src/runtime/runtime-config-snapshot';

describe('dashboard runtime config snapshot', () => {
  let testRoot: string;
  let originalCwd: string;
  let originalSkillsEnv: string | undefined;

  beforeEach(() => {
    originalCwd = process.cwd();
    originalSkillsEnv = process.env.XIAOBA_SKILLS_DIR;
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-runtime-config-'));
    process.chdir(testRoot);
    process.env.XIAOBA_SKILLS_DIR = path.join(testRoot, 'skills');
    writeSkill('snapshot-demo');
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalSkillsEnv === undefined) delete process.env.XIAOBA_SKILLS_DIR;
    else process.env.XIAOBA_SKILLS_DIR = originalSkillsEnv;
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('exposes read-only runtime facts without leaking secrets', async () => {
    const snapshot = await createRuntimeConfigSnapshot({
      now: new Date('2026-05-03T00:00:00.000Z'),
      profileConfigPath: path.join(testRoot, 'missing-runtime-profile.json'),
      config: {
        provider: 'openai',
        apiUrl: 'https://user:pass@example.test/v1/chat/completions?token=model-secret',
        apiKey: 'secret-key',
        model: 'test-model',
        temperature: 0.1,
        maxTokens: 2048,
        catscoLogUpload: {
          enabled: true,
          serverUrl: 'https://token:secret@logs.example.test:8000/ingest?api_key=secret',
          intervalMinutes: 15,
        },
      },
      env: {
        CURRENT_AGENT_DISPLAY_NAME: 'Desk Assistant',
        CURRENT_PLATFORM: '飞书',
      },
    });

    assert.equal(snapshot.generatedAt, '2026-05-03T00:00:00.000Z');
    assert.equal(snapshot.profileConfig.exists, false);
    assert.equal(snapshot.profileConfig.loaded, false);
    assert.equal(snapshot.validation.valid, true);
    assert.equal(snapshot.profile.surface, 'feishu');
    assert.equal(snapshot.profile.model.model, 'test-model');
    assert.equal(snapshot.profile.model.apiUrl, 'https://example.test');
    assert.equal((snapshot.profile.model as any).apiKey, undefined);
    assert.equal(JSON.stringify(snapshot).includes('secret-key'), false);
    assert.equal(JSON.stringify(snapshot).includes('model-secret'), false);
    assert.equal(JSON.stringify(snapshot).includes('user:pass'), false);
    assert.equal(snapshot.workingDirectory.path, fs.realpathSync(testRoot));
    assert.equal(snapshot.workingDirectory.exists, true);
    assert.match(snapshot.systemPrompt.text, /你在这个平台上的名字是：Desk Assistant/);
    assert.match(snapshot.systemPrompt.text, /Current directory is provided in a transient message/);
    assert.doesNotMatch(snapshot.systemPrompt.text.replace(/\\/g, '/'), new RegExp(escapeRegExp(fs.realpathSync(testRoot).replace(/\\/g, '/'))));
    assert.equal(snapshot.logging.sessionLogDir, path.join(fs.realpathSync(testRoot), 'logs/sessions'));
    assert.equal(snapshot.logging.upload.enabled, true);
    assert.equal(snapshot.logging.upload.serverUrl, 'https://logs.example.test:8000');
    assert.equal(JSON.stringify(snapshot).includes('api_key=secret'), false);
    assert.equal(JSON.stringify(snapshot).includes('token:secret'), false);
  });

  test('shows actual registered tools and loaded skills', async () => {
    const snapshot = await createRuntimeConfigSnapshot({
      config: {},
      env: {},
      profileConfigPath: path.join(testRoot, 'missing-runtime-profile.json'),
    });

    const enabledTools = snapshot.tools.enabled.map(tool => tool.name);
    assert.ok(enabledTools.includes('send_text'));
    assert.ok(enabledTools.includes('send_file'));
    assert.equal(enabledTools.includes('reply'), false);
    assert.equal(
      snapshot.tools.enabled.find(tool => tool.name === 'send_text')?.transcriptMode,
      'outbound_message',
    );
    assert.equal(
      snapshot.tools.enabled.find(tool => tool.name === 'send_file')?.transcriptMode,
      'outbound_file',
    );
    assert.deepStrictEqual(snapshot.skills.items.map(skill => skill.name), ['snapshot-demo']);
  });

  test('applies runtime profile file to dashboard snapshot with config metadata', async () => {
    const profilePath = path.join(testRoot, 'profiles', 'runtime-profile.json');
    const workspace = path.join(testRoot, 'profiles', 'workspace');
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    fs.writeFileSync(profilePath, JSON.stringify({
      schemaVersion: 1,
      profile: {
        displayName: 'Dashboard Bot',
        workingDirectory: 'workspace',
        model: {
          apiUrl: 'https://user:pass@profile.example.test/v1?token=profile-secret',
          model: 'profile-model',
        },
        tools: {
          enabled: ['read_file', 'execute_shell'],
        },
      },
    }), 'utf-8');

    const snapshot = await createRuntimeConfigSnapshot({
      config: {},
      env: {},
      profileConfigPath: profilePath,
    });

    assert.equal(snapshot.profileConfig.path, profilePath);
    assert.equal(snapshot.profileConfig.exists, true);
    assert.equal(snapshot.profileConfig.loaded, true);
    assert.deepStrictEqual(snapshot.profileConfig.issues, []);
    assert.equal(snapshot.profile.displayName, 'Dashboard Bot');
    assert.equal(snapshot.profile.model.apiUrl, 'https://profile.example.test');
    assert.equal(snapshot.profile.model.model, 'profile-model');
    assert.equal(snapshot.profile.workingDirectory, workspace);
    assert.deepStrictEqual(snapshot.tools.enabled.map(tool => tool.name), ['read_file', 'execute_shell']);
    assert.match(snapshot.systemPrompt.text, /你在这个平台上的名字是：Dashboard Bot/);
    assert.equal(JSON.stringify(snapshot).includes('profile-secret'), false);
    assert.equal(JSON.stringify(snapshot).includes('user:pass'), false);
  });
});

function writeSkill(name: string): void {
  const dir = path.join(process.cwd(), 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      'description: Demo skill for runtime config snapshot',
      'user-invocable: true',
      '---',
      '',
      'Demo skill body.',
      '',
    ].join('\n'),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
