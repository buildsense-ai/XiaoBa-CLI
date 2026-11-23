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
  test('defaults new installations to Wiki Search', () => {
    const root = tempRoot();
    const config = loadBranchAgentConfig({ runtimeRoot: root });
    assert.equal(config.branches.memorySearch.enabled, true);
    assert.equal(config.branches.memorySearch.kind, 'wiki');
    assert.deepEqual(config.branches.memorySearch.model, { kind: 'inherit' });
    assert.deepEqual(config.branches.memorySearch.budget, {
      maxTurnsPerPass: 4,
      maxPasses: 2,
      deadlineMs: 45_000,
      maxContextTokens: 16_000,
    });
    assert.equal(resolveMemoryBranchModelOverride(config), undefined);
    assert.equal(fs.existsSync(path.join(root, BRANCH_AGENT_CONFIG_FILE)), false);
  });

  test('concurrent v1 readers discard obsolete settings without overwriting new choices', async () => {
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
      'const config = branchConfig.loadBranchAgentConfig({ runtimeRoot: process.env.BRANCH_TEST_ROOT });',
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
    assert.deepEqual(readers.map(result => result.stdout), Array(6).fill('true'));
    assert.equal(fs.readFileSync(configPath, 'utf-8'), legacyFile);

    const migrated = loadBranchAgentConfig({ runtimeRoot: root });
    assert.equal(migrated.schema, BRANCH_AGENT_CONFIG_SCHEMA);
    assert.equal(migrated.branches.memorySearch.enabled, true);
    assert.equal(migrated.branches.memorySearch.kind, 'wiki');
    assert.deepEqual(migrated.branches.memorySearch.model, { kind: 'inherit' });
    assert.equal(migrated.branches.memorySearch.customDraft, undefined);

    migrated.branches.memorySearch.enabled = false;
    saveBranchAgentConfig(migrated, { runtimeRoot: root });
    const reloaded = loadBranchAgentConfig({ runtimeRoot: root });
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf-8')).schema, BRANCH_AGENT_CONFIG_SCHEMA);
    assert.equal(reloaded.branches.memorySearch.enabled, false);
    assert.equal(reloaded.branches.memorySearch.customDraft, undefined);
    const postSaveReader = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', script],
      childOptions,
    );
    assert.equal(postSaveReader.stdout, 'false');
  });

  test('switches all v2 devices to Wiki regardless of their previous mode', () => {
    const root = tempRoot();
    for (const prior of [{ enabled: false }, { enabled: true }, { enabled: true, kind: 'wiki' }]) {
      fs.writeFileSync(path.join(root, BRANCH_AGENT_CONFIG_FILE), JSON.stringify({
        schema: 'xiaoba.branch-agents.v2',
        branches: { memorySearch: { ...prior, model: {
          kind: 'custom', provider: 'openai', apiBase: 'https://old.example.test/v1',
          apiKey: 'old-key', model: 'old-model', contextWindowTokens: 64_000,
          capabilities: { toolCalling: true },
        } } },
      }));
      const { enabled, kind, model } = loadBranchAgentConfig({ runtimeRoot: root }).branches.memorySearch;
      assert.deepEqual({ enabled, kind, model }, { enabled: true, kind: 'wiki', model: { kind: 'inherit' } });
    }
  });

  test('persists a dedicated custom model and resolves every model-affecting field', () => {
    const root = tempRoot();
    const config = loadBranchAgentConfig({ runtimeRoot: root });
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
    saveBranchAgentConfig(config, { runtimeRoot: root });
    config.branches.memorySearch.enabled = false;
    saveBranchAgentConfig(config, { runtimeRoot: root });

    const stored = loadBranchAgentConfig({ runtimeRoot: root });
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

  test('pins customDraft as a Dashboard-only draft: it never resolves into a runtime override', () => {
    const root = tempRoot();
    const config = loadBranchAgentConfig({ runtimeRoot: root });
    config.branches.memorySearch.model = { kind: 'inherit' };
    config.branches.memorySearch.customDraft = {
      kind: 'custom',
      provider: 'anthropic',
      apiBase: 'https://draft.example.test/anthropic',
      apiKey: 'draft-secret',
      model: 'draft-model',
      contextWindowTokens: 128_000,
      capabilities: { toolCalling: true },
    };
    saveBranchAgentConfig(config, { runtimeRoot: root });

    const stored = loadBranchAgentConfig({ runtimeRoot: root });
    assert.equal(stored.branches.memorySearch.model.kind, 'inherit');
    assert.equal(stored.branches.memorySearch.customDraft?.apiKey, 'draft-secret');
    assert.equal(resolveMemoryBranchModelOverride(stored), undefined);
  });

  test('RuntimeFactory does not use an unsaved draft or primary model for the default Branch', () => {
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
      const config = loadBranchAgentConfig({ runtimeRoot: root });
      config.branches.memorySearch.model = { kind: 'inherit' };
      config.branches.memorySearch.customDraft = {
        kind: 'custom', provider: 'anthropic', apiBase: 'https://draft.example.test/anthropic',
        apiKey: 'draft-secret', model: 'draft-model', contextWindowTokens: 128_000,
        capabilities: { toolCalling: true },
      };
      saveBranchAgentConfig(config, { runtimeRoot: root });
      const profile = resolveDefaultRuntimeProfile({ surface: 'catscompany', workingDirectory: root });
      const services = RuntimeFactory.createServicesSync(profile);
      assert.equal(services.memoryBranch?.modelSource, 'official-deepseek');
      assert.equal(services.memoryBranch?.aiService, undefined);
      assert.equal(services.aiService.getConfig().model, 'primary-model');
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

  test('falls back safely when the local config is corrupt', () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, BRANCH_AGENT_CONFIG_FILE), '{not-json', 'utf-8');
    const config = loadBranchAgentConfig({ runtimeRoot: root });
    assert.equal(config.branches.memorySearch.enabled, true);
    assert.equal(config.branches.memorySearch.kind, 'wiki');
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
        schema: BRANCH_AGENT_CONFIG_SCHEMA,
        branches: { memorySearch: { enabled: true, model } },
      }), 'utf-8');
      assert.equal(loadBranchAgentConfig({ runtimeRoot: root }).branches.memorySearch.model.kind, 'inherit');
    }
  });

  test('normalizes persisted branch budgets to finite safe bounds', () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, BRANCH_AGENT_CONFIG_FILE), JSON.stringify({
      schema: BRANCH_AGENT_CONFIG_SCHEMA,
      branches: {
        memorySearch: {
          enabled: true,
          model: { kind: 'inherit' },
          budget: {
            maxTurnsPerPass: 10_000,
            maxPasses: 0,
            deadlineMs: 'not-a-number',
            maxContextTokens: 12_345,
          },
        },
      },
    }), 'utf-8');

    assert.deepEqual(loadBranchAgentConfig({ runtimeRoot: root }).branches.memorySearch.budget, {
      maxTurnsPerPass: 64,
      maxPasses: 2,
      deadlineMs: 45_000,
      maxContextTokens: 12_345,
    });
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
      const config = loadBranchAgentConfig({ runtimeRoot: root });
      config.branches.memorySearch.kind = 'memory';
      config.branches.memorySearch.model = {
        kind: 'custom', provider: 'anthropic', apiBase: 'https://branch.example.test/anthropic',
        apiKey: 'branch-secret', model: 'branch-model', contextWindowTokens: 200000,
        capabilities: { toolCalling: true },
      };
      saveBranchAgentConfig(config, { runtimeRoot: root });
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
      const config = loadBranchAgentConfig({ runtimeRoot: root });
      config.branches.memorySearch.enabled = true;
      saveBranchAgentConfig(config, { runtimeRoot: root });
      process.env.XIAOBA_USER_DATA_DIR = root;
      process.env.XIAOBA_BRANCH_AGENTS_ENABLED = 'false';
      process.env.XIAOBA_MEMORY_SIDECAR_ENABLED = 'false';
      process.env.GAUZ_LLM_PROVIDER = 'openai';
      process.env.GAUZ_LLM_API_BASE = 'https://relay.catsco.cc/anthropic';
      process.env.GAUZ_LLM_API_KEY = 'primary-secret';
      process.env.GAUZ_LLM_MODEL = 'primary-model';

      const profile = resolveDefaultRuntimeProfile({ surface: 'catscompany', workingDirectory: root });
      const services = RuntimeFactory.createServicesSync(profile);
      assert.equal(services.memoryBranch?.enabled, true);
      const branch = services.memoryBranch?.aiService?.getConfig();
      assert.equal(branch?.model, 'deepseek-flash');
      assert.equal(branch?.apiUrl, 'https://relay.catsco.cc/v1');
      assert.equal(branch?.openaiApiMode, 'responses');
      assert.equal(branch?.reasoningEffort, 'high');
      assert.equal(services.aiService.getConfig().model, 'primary-model');
      assert.equal(services.catslogMemory, undefined);

      config.branches.memorySearch.kind = 'memory';
      saveBranchAgentConfig(config, { runtimeRoot: root });
      const legacyServices = RuntimeFactory.createServicesSync(profile);
      assert.equal(legacyServices.memoryBranch?.kind, 'memory');
      assert.equal(legacyServices.memoryBranch?.modelSource, 'inherit');
      assert.ok(legacyServices.catslogMemory);
      assert.equal(legacyServices.memoryBranch?.wikiMemory, undefined);
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

  test('Wiki uses the separately saved Relay when the primary model is custom', t => {
    const root = tempRoot();
    const env = {
      XIAOBA_USER_DATA_DIR: root,
      GAUZ_LLM_PROVIDER: 'openai',
      GAUZ_LLM_API_BASE: 'https://primary.example.test/v1',
      GAUZ_LLM_API_KEY: 'primary-secret',
      GAUZ_LLM_MODEL: 'primary-model',
      CATSCO_RELAY_LLM_API_BASE: 'https://relay.catsco.cn/v1',
      CATSCO_RELAY_LLM_API_KEY: 'relay-secret',
    };
    for (const [key, value] of Object.entries(env)) {
      const previous = process.env[key];
      process.env[key] = value;
      t.after(() => {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      });
    }
    const profile = resolveDefaultRuntimeProfile({ surface: 'catscompany', workingDirectory: root });
    const services = RuntimeFactory.createServicesSync(profile);
    assert.equal(services.aiService.getConfig().model, 'primary-model');
    assert.equal(services.memoryBranch?.kind, 'wiki');
    const branch = services.memoryBranch?.aiService?.getConfig();
    assert.equal(branch?.apiKey, 'relay-secret');
    assert.equal(branch?.model, 'deepseek-flash');
    assert.equal(branch?.reasoningEffort, 'high');
  });
});
