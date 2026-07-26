import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import type { Server } from 'node:http';
import { createApiRouter } from '../src/dashboard/routes/api';
import { loadBranchAgentConfig, saveBranchAgentConfig } from '../src/core/branch-agent-config';

describe('Dashboard Branch agent API', () => {
  let root: string;
  let server: Server;
  let baseUrl: string;
  let originalRuntimeRoot: string | undefined;
  let originalLegacySwitch: string | undefined;
  let originalMemorySidecarSwitch: string | undefined;
  let originalMainModel: string | undefined;
  let restartCalls: string[];
  let serviceStatus: 'running' | 'stopped';

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-branch-api-'));
    originalRuntimeRoot = process.env.XIAOBA_USER_DATA_DIR;
    originalLegacySwitch = process.env.XIAOBA_BRANCH_AGENTS_ENABLED;
    originalMemorySidecarSwitch = process.env.XIAOBA_MEMORY_SIDECAR_ENABLED;
    originalMainModel = process.env.GAUZ_LLM_MODEL;
    process.env.XIAOBA_USER_DATA_DIR = root;
    delete process.env.XIAOBA_BRANCH_AGENTS_ENABLED;
    delete process.env.XIAOBA_MEMORY_SIDECAR_ENABLED;
    restartCalls = [];
    serviceStatus = 'running';
    const serviceManager = {
      getAll: () => [],
      getService: (name: string) => name === 'catscompany'
        ? { name, status: serviceStatus, ...(serviceStatus === 'running' ? { pid: 101 } : {}) }
        : undefined,
      restart: (name: string) => { restartCalls.push(name); return { name, status: 'stopping' }; },
    };
    const app = express();
    app.use(express.json());
    app.use('/api', createApiRouter(serviceManager as any, undefined, {
      modelsDevFetch: (async () => new Response('', { status: 503 })) as typeof fetch,
    }));
    server = await new Promise<Server>(resolve => {
      const next = app.listen(0, '127.0.0.1', () => resolve(next));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (originalRuntimeRoot === undefined) delete process.env.XIAOBA_USER_DATA_DIR;
    else process.env.XIAOBA_USER_DATA_DIR = originalRuntimeRoot;
    if (originalLegacySwitch === undefined) delete process.env.XIAOBA_BRANCH_AGENTS_ENABLED;
    else process.env.XIAOBA_BRANCH_AGENTS_ENABLED = originalLegacySwitch;
    if (originalMemorySidecarSwitch === undefined) delete process.env.XIAOBA_MEMORY_SIDECAR_ENABLED;
    else process.env.XIAOBA_MEMORY_SIDECAR_ENABLED = originalMemorySidecarSwitch;
    if (originalMainModel === undefined) delete process.env.GAUZ_LLM_MODEL;
    else process.env.GAUZ_LLM_MODEL = originalMainModel;
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('returns defaults without exposing a secret field', async () => {
    const response = await fetch(`${baseUrl}/api/branch-agents/memory`);
    const text = await response.text();
    const data = JSON.parse(text) as any;
    assert.equal(response.status, 200);
    assert.equal(data.enabled, true);
    assert.equal(data.modelSource, 'inherit');
    assert.equal(typeof data.primary.model, 'string');
    assert.equal(data.custom.apiKeyPresent, false);
    assert.equal(text.includes('apiKey"'), false);
  });

  test('saves a custom model, preserves the primary model env, and requests one connector restart', async () => {
    process.env.GAUZ_LLM_MODEL = 'primary-model';
    const response = await fetch(`${baseUrl}/api/branch-agents/memory/model/custom`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'openai',
        apiBase: 'https://branch.example.test/v1',
        model: 'branch-model',
        contextWindowTokens: 256000,
        reasoningEffort: 'high',
        openaiApiMode: 'responses',
        apiKey: { action: 'replace', value: 'branch-secret' },
      }),
    });
    const text = await response.text();
    const data = JSON.parse(text) as any;
    const stored = loadBranchAgentConfig({ runtimeRoot: root });
    assert.equal(response.status, 200);
    assert.equal(data.modelSource, 'custom');
    assert.equal(data.custom.apiKeyPresent, true);
    assert.equal(text.includes('branch-secret'), false);
    assert.equal(process.env.GAUZ_LLM_MODEL, 'primary-model');
    assert.equal(stored.branches.memorySearch.model.kind, 'custom');
    assert.deepEqual(restartCalls, ['catscompany']);
  });

  test('toggles only the persisted Memory Search switch without rewriting legacy env state', async () => {
    process.env.XIAOBA_BRANCH_AGENTS_ENABLED = 'legacy-marker';
    const response = await fetch(`${baseUrl}/api/branch-agents/memory/enabled`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    const data = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(data.enabled, false);
    assert.equal(loadBranchAgentConfig({ runtimeRoot: root }).branches.memorySearch.enabled, false);
    assert.equal(process.env.XIAOBA_BRANCH_AGENTS_ENABLED, 'legacy-marker');
    assert.deepEqual(restartCalls, ['catscompany']);
  });

  test('legacy Prompt endpoint updates the canonical config without rewriting env state', async () => {
    process.env.XIAOBA_BRANCH_AGENTS_ENABLED = 'false';
    const response = await fetch(`${baseUrl}/api/prompts/branch-agents`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
    const data = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(data.enabled, true);
    assert.equal(loadBranchAgentConfig({ runtimeRoot: root }).branches.memorySearch.enabled, true);
    assert.equal(process.env.XIAOBA_BRANCH_AGENTS_ENABLED, 'false');
    assert.deepEqual(restartCalls, ['catscompany']);
  });

  test('switches custom -> inherit -> custom without losing the saved custom model or secret', async () => {
    const customPayload = {
      provider: 'openai',
      apiBase: 'https://branch.example.test/v1',
      model: 'branch-model',
      contextWindowTokens: 256000,
      reasoningEffort: 'high',
      openaiApiMode: 'responses',
      apiKey: { action: 'replace', value: 'branch-secret' },
    };
    const customResponse = await fetch(`${baseUrl}/api/branch-agents/memory/model/custom`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(customPayload),
    });
    assert.equal(customResponse.status, 200);

    const inheritResponse = await fetch(`${baseUrl}/api/branch-agents/memory/model/inherit`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const inheritText = await inheritResponse.text();
    const inheritData = JSON.parse(inheritText) as any;
    const inherited = loadBranchAgentConfig({ runtimeRoot: root }).branches.memorySearch;
    assert.equal(inheritResponse.status, 200);
    assert.equal(inheritData.modelSource, 'inherit');
    assert.equal(inheritData.custom.apiKeyPresent, true);
    assert.equal(inheritText.includes('branch-secret'), false);
    assert.deepEqual(inherited.model, { kind: 'inherit' });
    assert.equal(inherited.customDraft?.apiKey, 'branch-secret');
    assert.equal(inherited.customDraft?.reasoningEffort, 'high');
    assert.equal(inherited.customDraft?.openaiApiMode, 'responses');

    const restoreResponse = await fetch(`${baseUrl}/api/branch-agents/memory/model/custom`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...customPayload, apiKey: { action: 'keep' } }),
    });
    const restoreText = await restoreResponse.text();
    const restored = loadBranchAgentConfig({ runtimeRoot: root }).branches.memorySearch;
    assert.equal(restoreResponse.status, 200);
    assert.equal(restoreText.includes('branch-secret'), false);
    assert.equal(restored.model.kind, 'custom');
    assert.equal(restored.model.kind === 'custom' ? restored.model.apiKey : '', 'branch-secret');
    assert.equal(restored.customDraft?.apiKey, 'branch-secret');
    assert.deepEqual(restartCalls, ['catscompany', 'catscompany', 'catscompany']);
  });

  test('switching a legacy active custom model to inherit archives it and does not start a stopped Connector', async () => {
    const config = loadBranchAgentConfig({ runtimeRoot: root });
    config.branches.memorySearch.model = {
      kind: 'custom', provider: 'openai', apiBase: 'https://branch.example.test/v1',
      apiKey: 'branch-secret', model: 'branch-model', contextWindowTokens: 256000,
      capabilities: { toolCalling: true },
    };
    delete config.branches.memorySearch.customDraft;
    saveBranchAgentConfig(config, { runtimeRoot: root });
    serviceStatus = 'stopped';

    const response = await fetch(`${baseUrl}/api/branch-agents/memory/model/inherit`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    const stored = loadBranchAgentConfig({ runtimeRoot: root }).branches.memorySearch;
    assert.equal(response.status, 200);
    assert.deepEqual(stored.model, { kind: 'inherit' });
    assert.equal(stored.customDraft?.apiKey, 'branch-secret');
    assert.deepEqual(restartCalls, []);
  });

  test('rejects unsafe custom model URLs before changing device config', async () => {
    const response = await fetch(`${baseUrl}/api/branch-agents/memory/model/custom`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'openai',
        apiBase: 'https://user:secret@branch.example.test/v1?token=leak',
        model: 'branch-model',
        contextWindowTokens: 256000,
        apiKey: { action: 'replace', value: 'branch-secret' },
      }),
    });
    assert.equal(response.status, 400);
    assert.equal(loadBranchAgentConfig({ runtimeRoot: root }).branches.memorySearch.model.kind, 'inherit');
    assert.deepEqual(restartCalls, []);
  });

  test('rejects non-string and control-character model material', async () => {
    for (const payload of [
      {
        provider: 'openai', apiBase: 'https://branch.example.test/v1', model: {},
        contextWindowTokens: 256000, apiKey: { action: 'replace', value: 'valid-key' },
      },
      {
        provider: 'openai', apiBase: 'https://branch.example.test/v1', model: 'model\tname',
        contextWindowTokens: 256000, apiKey: { action: 'replace', value: [] },
      },
      {
        provider: 'openai', apiBase: 'https://branch.example.test/v1\u0000', model: 'model',
        contextWindowTokens: 256000, apiKey: { action: 'replace', value: 'key\u0000value' },
      },
    ]) {
      const response = await fetch(`${baseUrl}/api/branch-agents/memory/model/custom`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      assert.equal(response.status, 400);
    }
    assert.equal(loadBranchAgentConfig({ runtimeRoot: root }).branches.memorySearch.model.kind, 'inherit');
    assert.deepEqual(restartCalls, []);
  });

  test('clearing a saved custom credential does not change an active catalog model', async () => {
    const config = loadBranchAgentConfig({ runtimeRoot: root });
    config.branches.memorySearch.model = {
      kind: 'catalog', modelId: 'minimax-m3', provider: 'anthropic',
      apiBase: 'https://relay.catsco.cc/anthropic', apiKey: 'sk-existing-1234567890',
      model: 'MiniMax-M3', contextWindowTokens: 1000000, capabilities: { toolCalling: true },
    };
    saveBranchAgentConfig(config, { runtimeRoot: root });
    const response = await fetch(`${baseUrl}/api/branch-agents/memory/model/custom`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: { action: 'clear' } }),
    });
    const data = await response.json() as any;
    assert.equal(response.status, 200);
    assert.equal(data.modelSource, 'catalog');
    assert.equal(loadBranchAgentConfig({ runtimeRoot: root }).branches.memorySearch.model.kind, 'catalog');
    assert.equal(data.restartRequested, false);
    assert.deepEqual(restartCalls, []);
  });

  test('Tool Calling probe sends a 1024-token output budget', async () => {
    let requestBody: any;
    const modelApp = express();
    modelApp.use(express.json());
    modelApp.post('/v1/chat/completions', (req, res) => {
      requestBody = req.body;
      res.json({
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_probe',
              type: 'function',
              function: { name: 'branch_model_probe', arguments: '{"status":"ok"}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    });
    const modelServer = await new Promise<Server>(resolve => {
      const next = modelApp.listen(0, '127.0.0.1', () => resolve(next));
    });
    const address = modelServer.address();
    if (!address || typeof address === 'string') throw new Error('model server did not bind');
    try {
      const response = await fetch(`${baseUrl}/api/branch-agents/memory/model/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: 'openai',
          apiBase: `http://127.0.0.1:${address.port}/v1`,
          model: 'tool-model',
          contextWindowTokens: 256000,
          apiKey: { action: 'replace', value: 'test-key' },
        }),
      });
      const data = await response.json() as any;
      assert.equal(response.status, 200, JSON.stringify(data));
      assert.equal(data.toolCalling, true);
      assert.equal(requestBody?.max_tokens, 1024);
    } finally {
      await new Promise<void>(resolve => modelServer.close(() => resolve()));
    }
  });

  test('reuses a matching Branch relay key when the remote service cannot reveal it', async () => {
    let revealCalls = 0;
    let rotateCalls = 0;
    const catsApp = express();
    catsApp.use(express.json());
    catsApp.get('/api/relay/config', (_req, res) => res.json({ self_service_enabled: true }));
    catsApp.get('/api/relay/key', (_req, res) => res.json({
      key: { state: 'active', prefix: 'sk-abcde...wxyz' },
    }));
    catsApp.post('/api/relay/key/reveal', (_req, res) => { revealCalls += 1; res.status(404).json({ error: 'unsupported' }); });
    catsApp.post('/api/relay/key/rotate', (_req, res) => { rotateCalls += 1; res.json({ key: { key: 'unexpected' } }); });
    const catsServer = await new Promise<Server>(resolve => {
      const next = catsApp.listen(0, '127.0.0.1', () => resolve(next));
    });
    const address = catsServer.address();
    if (!address || typeof address === 'string') throw new Error('cats server did not bind');
    const previous = {
      token: process.env.CATSCO_USER_TOKEN,
      base: process.env.CATSCO_HTTP_BASE_URL,
      allow: process.env.CATSCO_ALLOW_LOCAL_ENDPOINTS,
    };
    try {
      process.env.CATSCO_USER_TOKEN = 'cats-user-token';
      process.env.CATSCO_HTTP_BASE_URL = `http://127.0.0.1:${address.port}`;
      process.env.CATSCO_ALLOW_LOCAL_ENDPOINTS = 'true';
      const config = loadBranchAgentConfig({ runtimeRoot: root });
      config.branches.memorySearch.model = {
        kind: 'catalog', modelId: 'minimax-m2.7', provider: 'anthropic',
        apiBase: 'https://relay.catsco.cc/anthropic', apiKey: 'sk-abcde1234567890wxyz',
        model: 'MiniMax-M2.7', contextWindowTokens: 204800, capabilities: { toolCalling: true },
      };
      saveBranchAgentConfig(config, { runtimeRoot: root });
      const response = await fetch(`${baseUrl}/api/branch-agents/memory/model/catalog/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: 'minimax-m3' }),
      });
      const data = await response.json() as any;
      assert.equal(response.status, 200, JSON.stringify(data));
      assert.equal(data.modelSource, 'catalog');
      assert.equal(revealCalls, 0);
      assert.equal(rotateCalls, 0);
    } finally {
      await new Promise<void>(resolve => catsServer.close(() => resolve()));
      if (previous.token === undefined) delete process.env.CATSCO_USER_TOKEN;
      else process.env.CATSCO_USER_TOKEN = previous.token;
      if (previous.base === undefined) delete process.env.CATSCO_HTTP_BASE_URL;
      else process.env.CATSCO_HTTP_BASE_URL = previous.base;
      if (previous.allow === undefined) delete process.env.CATSCO_ALLOW_LOCAL_ENDPOINTS;
      else process.env.CATSCO_ALLOW_LOCAL_ENDPOINTS = previous.allow;
    }
  });
});
