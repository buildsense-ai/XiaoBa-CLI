import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BRANCH_AGENT_CONFIG_FILE,
  loadBranchAgentConfig,
  resolveMemoryBranchModelOverride,
  saveBranchAgentConfig,
} from '../src/core/branch-agent-config';
import { RuntimeFactory } from '../src/runtime/runtime-factory';
import { resolveDefaultRuntimeProfile } from '../src/runtime/runtime-profile';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-branch-config-'));
  roots.push(root);
  return root;
}

describe('Branch agent device config', () => {
  test('defaults Memory Search to enabled and following the primary model', () => {
    const config = loadBranchAgentConfig({ runtimeRoot: tempRoot(), env: {} });
    assert.equal(config.branches.memorySearch.enabled, true);
    assert.deepEqual(config.branches.memorySearch.model, { kind: 'inherit' });
    assert.equal(resolveMemoryBranchModelOverride(config), undefined);
  });

  test('honors the legacy disabled switch until a device config is saved', () => {
    const config = loadBranchAgentConfig({
      runtimeRoot: tempRoot(),
      env: { XIAOBA_BRANCH_AGENTS_ENABLED: 'false' },
    });
    assert.equal(config.branches.memorySearch.enabled, false);
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
    const config = loadBranchAgentConfig({ runtimeRoot: root, env: {} });
    assert.equal(config.branches.memorySearch.enabled, true);
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
});
