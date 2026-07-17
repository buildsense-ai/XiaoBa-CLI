import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { prepareBoundBotDefinition } from '../src/bot-definition/activation';
import { createCatsCoLocalConfigService } from '../src/catscompany/local-config';
import { FileBotCatalogModelRuntimeRepository, FileBotDefinitionRepository } from '../src/bot-definition/repository';
import { resolveActiveBotLLMConfig } from '../src/bot-definition/llm-config-resolver';
import { BOT_DEFINITION_SCHEMA } from '../src/bot-definition/types';

describe('BotDefinition activation', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  test('materializes the selected catalog model before connector preflight instead of mixing stale legacy material', async () => {
    const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-definition-activation-runtime-'));
    const simulatedCloudRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-definition-activation-cloud-'));
    roots.push(runtimeRoot, simulatedCloudRoot);
    const env = {
      CATSCO_MODEL_SOURCE: 'relay',
      CATSCO_RELAY_LLM_PROVIDER: 'anthropic',
      CATSCO_RELAY_LLM_API_BASE: 'https://relay.example.test/anthropic',
      CATSCO_RELAY_LLM_MODEL: 'deepseek-v4-flash',
      CATSCO_RELAY_LLM_API_KEY: 'sk-stale-deepseek-material',
    } as NodeJS.ProcessEnv;

    createCatsCoLocalConfigService({ runtimeRoot, env }).save({
      version: 1,
      endpoints: {
        httpBaseUrl: 'https://cats.example.test',
        serverUrl: 'wss://cats.example.test/v0/channels',
      },
      account: { token: 'user-token', uid: 'user-1', displayName: 'Alice' },
      currentBot: {
        uid: 'bot-bravo',
        apiKey: 'bot-bravo-key',
        boundByUserUid: 'user-1',
        bindingSource: 'test',
      },
      device: { deviceId: 'device-1', bodyId: 'body-1', installationId: 'install-1' },
    });
    new FileBotDefinitionRepository({ runtimeRoot, simulatedCloudRoot }).writeCanonical({
      schema: BOT_DEFINITION_SCHEMA,
      botId: 'bot-bravo',
      model: { kind: 'catalog', modelId: 'minimax-m3' },
    });

    const requests: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push(`${init?.method || 'GET'} ${url.pathname}`);
      if (url.pathname === '/api/relay/config') {
        return Response.json({
          self_service_enabled: true,
          base_url: 'https://relay.example.test',
          endpoints: [{ protocol: 'Anthropic-compatible', base_url: 'https://relay.example.test/anthropic' }],
        });
      }
      if (url.pathname === '/api/relay/key') {
        return Response.json({ key: { state: 'active', key: 'sk-bravo-relay-material' } });
      }
      return Response.json({ error: 'unexpected request' }, { status: 500 });
    }) as typeof fetch;

    const prepared = await prepareBoundBotDefinition({
      runtimeRoot,
      simulatedCloudRoot,
      env,
      fetchImpl,
    });

    assert.equal(prepared?.botId, 'bot-bravo');
    assert.equal(prepared?.materializedCatalogRuntime, true);
    const runtime = new FileBotCatalogModelRuntimeRepository({ runtimeRoot }).read('bot-bravo');
    assert.equal(runtime?.modelId, 'minimax-m3');
    assert.equal(runtime?.model, 'MiniMax-M3');
    assert.equal(runtime?.apiKey, 'sk-bravo-relay-material');
    assert.equal(resolveActiveBotLLMConfig({ runtimeRoot, env })?.config.model, 'MiniMax-M3');
    assert.equal(resolveActiveBotLLMConfig({ runtimeRoot, env })?.config.apiKey, 'sk-bravo-relay-material');
    assert.equal(env.CATSCO_RELAY_LLM_API_KEY, undefined);
    assert.deepStrictEqual(requests, [
      'GET /api/relay/config',
      'GET /api/relay/key',
    ]);
  });
});
