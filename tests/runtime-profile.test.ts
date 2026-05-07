import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  resolveDefaultRuntimeProfile,
  validateRuntimeProfile,
} from '../src/runtime/runtime-profile';
import {
  getDefaultRuntimeProfileConfigPath,
  resolveRuntimeProfileFromConfig,
} from '../src/runtime/runtime-profile-config';
import { ToolManager } from '../src/tools/tool-manager';

describe('RuntimeProfile', () => {
  let testRoot: string;
  let originalCwd: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-runtime-profile-'));
    process.chdir(testRoot);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (testRoot && fs.existsSync(testRoot)) {
      fs.rmSync(testRoot, { recursive: true, force: true });
    }
  });

  test('describes current default CLI runtime facts', () => {
    const profile = resolveDefaultRuntimeProfile({
      env: {},
    });

    assert.equal(profile.id, 'xiaoba-cli');
    assert.equal(profile.displayName, 'CatsCo');
    assert.equal(profile.surface, 'cli');
    assert.equal(profile.workingDirectory, fs.realpathSync(testRoot));
    assert.deepStrictEqual(profile.model, {});
    assert.deepStrictEqual(profile.prompt, {
      source: 'prompt-manager',
      displayName: undefined,
      platform: undefined,
    });
    assert.deepStrictEqual(profile.tools.enabled, getCurrentToolManagerNames());
    assert.equal(profile.skills.enabled, true);
    assert.equal(profile.logging.sessionEvents, true);
  });

  test('uses runtime identity and surface from env without mutating process env', () => {
    const env = {
      CURRENT_AGENT_DISPLAY_NAME: 'Desk Bot',
      CURRENT_PLATFORM: '飞书',
    };

    const profile = resolveDefaultRuntimeProfile({ env });

    assert.equal(profile.id, 'xiaoba-feishu');
    assert.equal(profile.displayName, 'Desk Bot');
    assert.equal(profile.surface, 'feishu');
    assert.equal(profile.prompt.displayName, 'Desk Bot');
    assert.equal(profile.prompt.platform, '飞书');
  });

  test('resolves CatsCo env surface to legacy catscompany surface id', () => {
    const profile = resolveDefaultRuntimeProfile({
      env: {
        CURRENT_PLATFORM: 'CatsCo',
      },
    });

    assert.equal(profile.id, 'xiaoba-catscompany');
    assert.equal(profile.surface, 'catscompany');
  });

  test('supports explicit overrides for future factory wiring', () => {
    const profile = resolveDefaultRuntimeProfile({
      id: 'custom-profile',
      displayName: 'Custom',
      surface: 'catscompany',
      workingDirectory: 'workspace',
      model: {
        provider: 'openai',
        model: 'custom-model',
        apiUrl: 'https://example.com/v1',
        temperature: 0.2,
        maxTokens: 2048,
      },
      tools: ['read_file', 'execute_shell'],
      skillsEnabled: false,
      logging: {
        sessionEvents: false,
        uploadEnabled: true,
      },
      env: {},
    });

    assert.equal(profile.id, 'custom-profile');
    assert.equal(profile.displayName, 'Custom');
    assert.equal(profile.surface, 'catscompany');
    assert.equal(profile.workingDirectory, path.join(fs.realpathSync(testRoot), 'workspace'));
    assert.deepStrictEqual(profile.model, {
      provider: 'openai',
      model: 'custom-model',
      apiUrl: 'https://example.com/v1',
      temperature: 0.2,
      maxTokens: 2048,
    });
    assert.deepStrictEqual(profile.tools.enabled, ['read_file', 'execute_shell']);
    assert.equal(profile.skills.enabled, false);
    assert.deepStrictEqual(profile.logging, {
      sessionEvents: false,
      uploadEnabled: true,
    });
  });

  test('validates unknown and duplicate runtime tool names', () => {
    const profile = resolveDefaultRuntimeProfile({
      tools: ['read_file', 'read_file', 'missing_tool'],
      env: {},
    });

    assert.deepStrictEqual(validateRuntimeProfile(profile), [
      {
        path: 'tools.enabled[1]',
        message: 'Duplicate runtime tool: read_file',
        value: 'read_file',
      },
      {
        path: 'tools.enabled[2]',
        message: 'Unknown runtime tool: missing_tool',
        value: 'missing_tool',
      },
    ]);
  });

  test('loads runtime profile file after env-backed defaults', () => {
    const profilePath = path.join(testRoot, 'profiles', 'runtime-profile.json');
    const workspace = path.join(testRoot, 'profiles', 'workspace');
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    fs.writeFileSync(profilePath, JSON.stringify({
      schemaVersion: 1,
      profile: {
        displayName: 'Profile Bot',
        surface: 'catscompany',
        workingDirectory: 'workspace',
        model: {
          provider: 'openai',
          model: 'profile-model',
          temperature: 0.2,
        },
        tools: {
          enabled: ['read_file', 'execute_shell'],
        },
        skills: {
          enabled: false,
        },
        logging: {
          sessionEvents: false,
          uploadEnabled: true,
        },
      },
    }), 'utf-8');

    const resolved = resolveRuntimeProfileFromConfig({
      configPath: profilePath,
      env: {
        CURRENT_AGENT_DISPLAY_NAME: 'Env Bot',
        CURRENT_PLATFORM: '飞书',
      },
    });

    assert.equal(resolved.config.path, profilePath);
    assert.equal(resolved.config.exists, true);
    assert.equal(resolved.config.loaded, true);
    assert.deepStrictEqual(resolved.config.issues, []);
    assert.equal(resolved.profile.id, 'xiaoba-catscompany');
    assert.equal(resolved.profile.displayName, 'Profile Bot');
    assert.equal(resolved.profile.surface, 'catscompany');
    assert.equal(resolved.profile.workingDirectory, workspace);
    assert.equal(resolved.profile.prompt.displayName, 'Profile Bot');
    assert.equal(resolved.profile.prompt.platform, '飞书');
    assert.deepStrictEqual(resolved.profile.model, {
      provider: 'openai',
      model: 'profile-model',
      temperature: 0.2,
    });
    assert.deepStrictEqual(resolved.profile.tools.enabled, ['read_file', 'execute_shell']);
    assert.equal(resolved.profile.skills.enabled, false);
    assert.deepStrictEqual(resolved.profile.logging, {
      sessionEvents: false,
      uploadEnabled: true,
    });
  });

  test('keeps surface override owned by the caller adapter', () => {
    const profilePath = path.join(testRoot, 'runtime-profile.json');
    fs.writeFileSync(profilePath, JSON.stringify({
      schemaVersion: 1,
      profile: {
        surface: 'catscompany',
        displayName: 'Shared Bot',
      },
    }), 'utf-8');

    const resolved = resolveRuntimeProfileFromConfig({
      configPath: profilePath,
      surface: 'feishu',
      env: {},
    });

    assert.equal(resolved.profile.surface, 'feishu');
    assert.equal(resolved.profile.id, 'xiaoba-feishu');
    assert.equal(resolved.profile.displayName, 'Shared Bot');
  });

  test('reports secret fields in profile files without applying or leaking them', () => {
    const profilePath = path.join(testRoot, 'runtime-profile.json');
    fs.writeFileSync(profilePath, JSON.stringify({
      schemaVersion: 1,
      profile: {
        model: {
          model: 'safe-model',
          apiKey: 'secret-key',
        },
      },
    }), 'utf-8');

    const resolved = resolveRuntimeProfileFromConfig({
      configPath: profilePath,
      env: {},
    });

    assert.equal(resolved.config.loaded, true);
    assert.deepStrictEqual(resolved.config.issues, [{
      path: 'profile.model.apiKey',
      message: 'Secrets are not allowed in runtime profile files; keep API keys in env or user config',
    }]);
    assert.equal(resolved.profile.model.model, 'safe-model');
    assert.equal((resolved.profile.model as any).apiKey, undefined);
    assert.equal(JSON.stringify(resolved.config).includes('secret-key'), false);
  });

  test('resolves runtime profile config path from explicit path, env, or home default', () => {
    assert.equal(
      getDefaultRuntimeProfileConfigPath({
        configPath: 'profiles/runtime-profile.json',
        runtimeRoot: testRoot,
        env: {},
      }),
      path.join(testRoot, 'profiles/runtime-profile.json'),
    );
    assert.equal(
      getDefaultRuntimeProfileConfigPath({
        runtimeRoot: testRoot,
        env: { XIAOBA_RUNTIME_PROFILE_PATH: 'from-env.json' },
      }),
      path.join(testRoot, 'from-env.json'),
    );
    assert.equal(
      getDefaultRuntimeProfileConfigPath({
        homeDir: path.join(testRoot, 'home'),
        env: {},
      }),
      path.join(testRoot, 'home', '.xiaoba', 'runtime-profile.json'),
    );
  });
});

function getCurrentToolManagerNames(): string[] {
  return new ToolManager('/tmp/xiaoba-runtime-profile-tools')
    .getToolDefinitions()
    .map(definition => definition.name);
}
