import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  BRANCH_AGENT_CONFIG_SCHEMA,
  BRANCH_AGENT_CONFIG_FILE,
  loadBranchAgentConfig,
  resolveMemoryBranchModelOverride,
  saveBranchAgentConfig,
} from '../src/core/branch-agent-config';
import { RuntimeFactory } from '../src/runtime/runtime-factory';
import { resolveDefaultRuntimeProfile } from '../src/runtime/runtime-profile';

const roots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-branch-config-'));
  roots.push(root);
  return root;
}

describe('Branch agent device config', () => {
  test('defaults Memory Search to disabled and following the primary model', () => {
    const root = tempRoot();
    const config = loadBranchAgentConfig({ runtimeRoot: root, env: {} });
    assert.equal(config.branches.memorySearch.enabled, false);
    assert.deepEqual(config.branches.memorySearch.model, { kind: 'inherit' });
    assert.equal(resolveMemoryBranchModelOverride(config), undefined);
    assert.equal(fs.existsSync(path.join(root, BRANCH_AGENT_CONFIG_FILE)), false);
  });

  test('disables the legacy Branch switch when the device config is first created', () => {
    const root = tempRoot();
    const migrated = loadBranchAgentConfig({
      runtimeRoot: root,
      env: { XIAOBA_BRANCH_AGENTS_ENABLED: 'true' },
    });
    assert.equal(migrated.branches.memorySearch.enabled, false);
    const reloaded = loadBranchAgentConfig({
      runtimeRoot: root,
      env: { XIAOBA_BRANCH_AGENTS_ENABLED: 'true' },
    });
    assert.equal(reloaded.branches.memorySearch.enabled, false);
  });

  test('concurrent v1 readers do not write or overwrite later manual enablement', async () => {
    const root = tempRoot();
    const configPath = path.join(root, BRANCH_AGENT_CONFIG_FILE);
    const legacyFile = JSON.stringify({
      schema: 'xiaoba.branch-agents.v1',
      branches: {
        memorySearch: {
          enabled: true,
          model: {
            kind: 'custom',
            provider: 'openai',
            apiBase: 'https://models.example.test/v1',
            apiKey: 'branch-secret',
            model: 'branch-model',
            contextWindowTokens: 256_000,
            capabilities: { toolCalling: true },
          },
          customDraft: {
            kind: 'custom',
            provider: 'anthropic',
            apiBase: 'https://draft.example.test/v1',
            apiKey: 'draft-secret',
            model: 'draft-model',
            contextWindowTokens: 128_000,
            capabilities: { toolCalling: true },
          },
        },
      },
    });
    fs.writeFileSync(configPath, legacyFile, 'utf-8');

    const moduleUrl = pathToFileURL(path.join(process.cwd(), 'src/core/branch-agent-config.ts')).href;
    const script = [
      `const imported = await import(${JSON.stringify(moduleUrl)});`,
      'const branchConfig = imported.default ?? imported;',
      'const config = branchConfig.loadBranchAgentConfig({ runtimeRoot: process.env.BRANCH_TEST_ROOT, env: {} });',
      'process.stdout.write(String(config.branches.memorySearch.enabled));',
    ].join('\n');
    const childOptions = {
      cwd: process.cwd(),
      env: { ...process.env, BRANCH_TEST_ROOT: root },
    };
    const readers = await Promise.all(Array.from({ length: 6 }, () => execFileAsync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', script],
      childOptions,
    )));
    assert.deepEqual(readers.map(result => result.stdout), Array(6).fill('false'));
    assert.equal(fs.readFileSync(configPath, 'utf-8'), legacyFile);

    const migrated = loadBranchAgentConfig({ runtimeRoot: root, env: {} });
    assert.equal(migrated.schema, BRANCH_AGENT_CONFIG_SCHEMA);
    assert.equal(migrated.branches.memorySearch.enabled, false);
    const model = migrated.branches.memorySearch.model;
    assert.equal(model.kind, 'custom');
    assert.ok(model.kind === 'custom');
    assert.equal(model.apiKey, 'branch-secret');
    assert.equal(migrated.branches.memorySearch.customDraft?.apiKey, 'draft-secret');

    migrated.branches.memorySearch.enabled = true;
    saveBranchAgentConfig(migrated, { runtimeRoot: root });
    const reloaded = loadBranchAgentConfig({ runtimeRoot: root, env: {} });
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf-8')).schema, BRANCH_AGENT_CONFIG_SCHEMA);
    assert.equal(reloaded.branches.memorySearch.enabled, true);
    assert.equal(reloaded.branches.memorySearch.customDraft?.apiKey, 'draft-secret');
    const postSaveReader = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', script],
      childOptions,
    );
    assert.equal(postSaveReader.stdout, 'true');
  });

  test('migrates the old Memory sidecar switch and then ignores both legacy switches', () => {
    const root = tempRoot();
    const migrated = loadBranchAgentConfig({
      runtimeRoot: root,
      env: { XIAOBA_MEMORY_SIDECAR_ENABLED: 'false' },
    });
    assert.equal(migrated.branches.memorySearch.enabled, false);

    migrated.branches.memorySearch.enabled = true;
    saveBranchAgentConfig(migrated, { runtimeRoot: root });
    const reloaded = loadBranchAgentConfig({
      runtimeRoot: root,
      env: {
        XIAOBA_BRANCH_AGENTS_ENABLED: 'false',
        XIAOBA_MEMORY_SIDECAR_ENABLED: 'false',
      },
    });
    assert.equal(reloaded.branches.memorySearch.enabled, true);
  });

  test('publishes the first legacy migration atomically across concurrent processes', async () => {
    const root = tempRoot();
    const moduleUrl = pathToFileURL(path.join(process.cwd(), 'src/core/branch-agent-config.ts')).href;
    const script = [
      `const imported = await import(${JSON.stringify(moduleUrl)});`,
      'const branchConfig = imported.default ?? imported;',
      'const config = branchConfig.loadBranchAgentConfig({ runtimeRoot: process.env.BRANCH_TEST_ROOT, env: process.env });',
      'process.stdout.write(String(config.branches.memorySearch.enabled));',
    ].join('\n');
    const env = {
      ...process.env,
      BRANCH_TEST_ROOT: root,
      XIAOBA_BRANCH_AGENTS_ENABLED: 'false',
      XIAOBA_MEMORY_SIDECAR_ENABLED: 'false',
    };
    const results = await Promise.all(Array.from({ length: 6 }, () => execFileAsync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', script],
      { cwd: process.cwd(), env },
    )));
    assert.deepEqual(results.map(result => result.stdout), Array(6).fill('false'));
    const stored = JSON.parse(fs.readFileSync(path.join(root, BRANCH_AGENT_CONFIG_FILE), 'utf-8'));
    assert.equal(stored.branches.memorySearch.enabled, false);
  });

  test('persists a dedicated custom model and resolves every model-affecting field', () => {
    const root = tempRoot();
    const config = loadBranchAgentConfig({ runtimeRoot: root, env: {} });
    config.branches.memorySearch.model = {
      kind: 'custom',
      provider: 'openai',
      apiBase: 'https://models.example.test/v1',
      apiKey: 'branch-secret',
      model: 'branch-model',
      contextWindowTokens: 256_000,
      reasoningEffort: 'high',
      openaiApiMode: 'responses',
      capabilities: { toolCalling: true, vision: false },
    };
    saveBranchAgentConfig(config, { runtimeRoot: root, env: {} });
    config.branches.memorySearch.enabled = false;
    saveBranchAgentConfig(config, { runtimeRoot: root, env: {} });

    const stored = loadBranchAgentConfig({ runtimeRoot: root, env: {} });
    const override = resolveMemoryBranchModelOverride(stored);
    assert.equal(stored.branches.memorySearch.model.kind, 'custom');
    assert.equal(stored.branches.memorySearch.enabled, false);
    assert.equal(override?.apiKey, 'branch-secret');
    assert.equal(override?.apiUrl, 'https://models.example.test/v1');
    assert.equal(override?.model, 'branch-model');
    assert.equal(override?.contextWindowTokens, 256_000);
    assert.equal(override?.temperature, undefined);
    assert.equal(override?.maxTokens, undefined);
    assert.deepEqual(override?.modelCapabilities, { toolCalling: true, vision: false });
  });

  test('falls back safely when the local config is corrupt', () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, BRANCH_AGENT_CONFIG_FILE), '{not-json', 'utf-8');
    const config = loadBranchAgentConfig({
      runtimeRoot: root,
      env: {
        XIAOBA_BRANCH_AGENTS_ENABLED: 'false',
        XIAOBA_MEMORY_SIDECAR_ENABLED: 'false',
      },
    });
    assert.equal(config.branches.memorySearch.enabled, false);
    assert.equal(config.branches.memorySearch.model.kind, 'inherit');
  });

  test('falls back when valid JSON contains unsafe or incomplete model material', () => {
    for (const model of [
      {
        kind: 'custom', provider: 'openai', apiBase: 'file:///tmp/model', apiKey: 'secret',
        model: 'unsafe\nmodel', contextWindowTokens: 256000, capabilities: { toolCalling: true },
      },
      {
        kind: 'catalog', provider: 'anthropic', apiBase: 'https://relay.catsco.cc/anthropic',
        apiKey: 'sk-example-1234567890', model: 'MiniMax-M3', contextWindowTokens: 1000000,
        capabilities: { toolCalling: true },
      },
      {
        kind: 'catalog', modelId: {}, provider: 'anthropic', apiBase: 'https://relay.catsco.cc/anthropic',
        apiKey: {}, model: [], contextWindowTokens: 1000000, capabilities: { toolCalling: true },
      },
      {
        kind: 'custom', provider: 'openai', apiBase: 'https://models.example.test/v1',
        apiKey: 'secret\u0000value', model: 'model\tname', contextWindowTokens: 256000,
        capabilities: { toolCalling: true },
      },
    ]) {
      const root = tempRoot();
      fs.writeFileSync(path.join(root, BRANCH_AGENT_CONFIG_FILE), JSON.stringify({
        schema: 'xiaoba.branch-agents.v1',
        branches: { memorySearch: { enabled: true, model } },
      }), 'utf-8');
      assert.equal(loadBranchAgentConfig({ runtimeRoot: root, env: {} }).branches.memorySearch.model.kind, 'inherit');
    }
  });

  test('RuntimeFactory isolates the Memory Branch model while keeping the primary service unchanged', () => {
    const root = tempRoot();
    const previous = {
      runtimeRoot: process.env.XIAOBA_USER_DATA_DIR,
      provider: process.env.GAUZ_LLM_PROVIDER,
      apiBase: process.env.GAUZ_LLM_API_BASE,
      apiKey: process.env.GAUZ_LLM_API_KEY,
      model: process.env.GAUZ_LLM_MODEL,
    };
    try {
      process.env.XIAOBA_USER_DATA_DIR = root;
      process.env.GAUZ_LLM_PROVIDER = 'openai';
      process.env.GAUZ_LLM_API_BASE = 'https://primary.example.test/v1';
      process.env.GAUZ_LLM_API_KEY = 'primary-secret';
      process.env.GAUZ_LLM_MODEL = 'primary-model';
      const config = loadBranchAgentConfig({ runtimeRoot: root, env: process.env });
      config.branches.memorySearch.model = {
        kind: 'custom', provider: 'anthropic', apiBase: 'https://branch.example.test/anthropic',
        apiKey: 'branch-secret', model: 'branch-model', contextWindowTokens: 200000,
        capabilities: { toolCalling: true },
      };
      saveBranchAgentConfig(config, { runtimeRoot: root, env: process.env });
      const profile = resolveDefaultRuntimeProfile({ surface: 'catscompany', workingDirectory: root });
      const services = RuntimeFactory.createServicesSync(profile);
      assert.notEqual(services.memoryBranch?.aiService, services.aiService);
      assert.equal(services.aiService.getConfig().model, 'primary-model');
      assert.equal(services.memoryBranch?.aiService.getConfig().model, 'branch-model');
      assert.equal(services.memoryBranch?.aiService.getConfig().apiKey, 'branch-secret');
    } finally {
      for (const [key, value] of Object.entries({
        XIAOBA_USER_DATA_DIR: previous.runtimeRoot,
        GAUZ_LLM_PROVIDER: previous.provider,
        GAUZ_LLM_API_BASE: previous.apiBase,
        GAUZ_LLM_API_KEY: previous.apiKey,
        GAUZ_LLM_MODEL: previous.model,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('RuntimeFactory honors persisted enabled=true after both legacy env switches become false', () => {
    const root = tempRoot();
    const previous = {
      runtimeRoot: process.env.XIAOBA_USER_DATA_DIR,
      branchSwitch: process.env.XIAOBA_BRANCH_AGENTS_ENABLED,
      memorySwitch: process.env.XIAOBA_MEMORY_SIDECAR_ENABLED,
      provider: process.env.GAUZ_LLM_PROVIDER,
      apiBase: process.env.GAUZ_LLM_API_BASE,
      apiKey: process.env.GAUZ_LLM_API_KEY,
      model: process.env.GAUZ_LLM_MODEL,
    };
    try {
      const config = loadBranchAgentConfig({ runtimeRoot: root, env: {} });
      config.branches.memorySearch.enabled = true;
      saveBranchAgentConfig(config, { runtimeRoot: root });
      process.env.XIAOBA_USER_DATA_DIR = root;
      process.env.XIAOBA_BRANCH_AGENTS_ENABLED = 'false';
      process.env.XIAOBA_MEMORY_SIDECAR_ENABLED = 'false';
      process.env.GAUZ_LLM_PROVIDER = 'openai';
      process.env.GAUZ_LLM_API_BASE = 'https://primary.example.test/v1';
      process.env.GAUZ_LLM_API_KEY = 'primary-secret';
      process.env.GAUZ_LLM_MODEL = 'primary-model';

      const profile = resolveDefaultRuntimeProfile({ surface: 'catscompany', workingDirectory: root });
      const services = RuntimeFactory.createServicesSync(profile);
      assert.equal(services.memoryBranch?.enabled, true);
      assert.equal(services.memoryBranch?.aiService, services.aiService);
    } finally {
      for (const [key, value] of Object.entries({
        XIAOBA_USER_DATA_DIR: previous.runtimeRoot,
        XIAOBA_BRANCH_AGENTS_ENABLED: previous.branchSwitch,
        XIAOBA_MEMORY_SIDECAR_ENABLED: previous.memorySwitch,
        GAUZ_LLM_PROVIDER: previous.provider,
        GAUZ_LLM_API_BASE: previous.apiBase,
        GAUZ_LLM_API_KEY: previous.apiKey,
        GAUZ_LLM_MODEL: previous.model,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
