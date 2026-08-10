import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  acknowledgeCloudBotDefinition,
  acknowledgeCloudBotModelSelection,
  patchCloudBotDefinitionModel,
  patchCloudBotDefinitionPrompt,
  pullCloudBotDefinition,
  pullCloudBotModelSelection,
} from '../src/bot-definition/cloud-client';

const auth = {
  apiKey: 'bot-api-key',
  httpBaseUrl: 'https://cats.example.test',
} as any;

describe('cloud bot model client local handoff', () => {
  test('reads the canonical BotDefinition with the bot credential', async () => {
    let authorization = '';
    const snapshot = await pullCloudBotDefinition({
      botId: '43',
      auth,
      fetchImpl: (async (input, init) => {
        assert.equal(String(input), 'https://cats.example.test/api/bot/definition');
        authorization = String((init?.headers as Record<string, string>)?.Authorization || '');
        return Response.json({
          uid: 43,
          configured: true,
          revision: 4,
          definition: {
            schema: 'xiaoba.bot-definition.v1',
            botId: '43',
            model: { kind: 'catalog', modelId: 'minimax-m3' },
            prompt: { selected: 'default' },
          },
          runtime: { desiredRevision: 4, appliedRevision: 3 },
        });
      }) as typeof fetch,
    });

    assert.equal(authorization, 'ApiKey bot-api-key');
    assert.deepStrictEqual(snapshot, {
      configured: true,
      revision: 4,
      definition: {
        schema: 'xiaoba.bot-definition.v1',
        botId: '43',
        model: { kind: 'catalog', modelId: 'minimax-m3' },
        prompt: { selected: 'default' },
      },
      runtime: { desiredRevision: 4, appliedRevision: 3 },
    });
  });

  test('restores a cloud custom model and preserves custom prompt text exactly', async () => {
    const snapshot = await pullCloudBotDefinition({
      botId: '43',
      auth,
      fetchImpl: (async () => Response.json({
        uid: 43,
        configured: true,
        revision: 5,
        definition: {
          schema: 'xiaoba.bot-definition.v1',
          botId: '43',
          model: {
            kind: 'custom',
            protocol: 'openai-responses',
            apiBase: 'https://relay.example.test/v1',
            model: 'gpt-private',
            apiKey: 'secret-key',
            contextWindowTokens: 256000,
            maxTokens: 8192,
            temperature: 0.7,
            reasoningEffort: 'high',
          },
          prompt: {
            selected: 'custom',
            customSystemPrompt: '\nPreserve this spacing.\n',
          },
        },
      })) as typeof fetch,
    });

    assert.deepStrictEqual(snapshot?.definition, {
      schema: 'xiaoba.bot-definition.v1',
      botId: '43',
      model: {
        kind: 'custom',
        protocol: 'openai-responses',
        apiBase: 'https://relay.example.test/v1',
        model: 'gpt-private',
        apiKey: 'secret-key',
        contextWindowTokens: 256000,
        maxTokens: 8192,
        temperature: 0.7,
        reasoningEffort: 'high',
      },
      prompt: {
        selected: 'custom',
        customSystemPrompt: '\nPreserve this spacing.\n',
      },
    });
  });

  test('patches model and prompt with owner auth and acknowledges with bot auth', async () => {
    const requests: Array<{ url: string; authorization: string; body: any }> = [];
    const fetchImpl = (async (input, init) => {
      requests.push({
        url: String(input),
        authorization: String((init?.headers as Record<string, string>)?.Authorization || ''),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return Response.json({ revision: requests.length });
    }) as typeof fetch;
    const ownerAndBotAuth = {
      ...auth,
      token: 'owner-token',
    } as any;

    assert.equal(await patchCloudBotDefinitionModel({
      botId: '43',
      auth: ownerAndBotAuth,
      fetchImpl,
    }, { kind: 'catalog', modelId: 'gpt-5.6-sol', reasoningEffort: 'high' }, 7), 1);
    assert.equal(await patchCloudBotDefinitionPrompt({
      botId: '43',
      auth: ownerAndBotAuth,
      fetchImpl,
    }, { selected: 'custom', customSystemPrompt: 'Custom prompt.' }, 8), 2);
    await acknowledgeCloudBotDefinition({
      botId: '43',
      auth: ownerAndBotAuth,
      fetchImpl,
    }, 9, 'apply failed');

    assert.deepStrictEqual(requests, [
      {
        url: 'https://cats.example.test/api/bots/definition/model?uid=43',
        authorization: 'Bearer owner-token',
        body: {
          revision: 7,
          model: { kind: 'catalog', modelId: 'gpt-5.6-sol', reasoningEffort: 'high' },
        },
      },
      {
        url: 'https://cats.example.test/api/bots/definition/prompt?uid=43',
        authorization: 'Bearer owner-token',
        body: {
          revision: 8,
          prompt: { selected: 'custom', customSystemPrompt: 'Custom prompt.' },
        },
      },
      {
        url: 'https://cats.example.test/api/bot/definition/ack',
        authorization: 'ApiKey bot-api-key',
        body: { revision: 9, error: 'apply failed' },
      },
    ]);
  });

  test('returns an explicit local revision after cloud management is disabled', async () => {
    const selection = await pullCloudBotModelSelection({
      botId: '43',
      auth,
      fetchImpl: (async () => Response.json({
        uid: 43,
        configured: false,
        desired: { kind: 'local', model_id: 'local', revision: 7 },
      })) as typeof fetch,
    });

    assert.deepStrictEqual(selection, { kind: 'local', modelId: 'local', revision: 7 });
  });

  test('reads a canonical local handoff without treating it as an invalid catalog model', async () => {
    const selection = await pullCloudBotModelSelection({
      botId: '43',
      auth,
      fetchImpl: (async () => Response.json({
        uid: 43,
        configured: true,
        revision: 8,
        definition: {
          schema: 'xiaoba.bot-definition.v1',
          botId: '43',
          model: { kind: 'local', modelId: 'local' },
          prompt: { selected: 'default' },
        },
      })) as typeof fetch,
    });

    assert.deepStrictEqual(selection, {
      kind: 'local',
      modelId: 'local',
      revision: 8,
      definition: {
        schema: 'xiaoba.bot-definition.v1',
        botId: '43',
        model: { kind: 'local', modelId: 'local' },
        prompt: { selected: 'default' },
      },
    });
  });

  test('keeps an untouched revision zero configuration as local-only state', async () => {
    const selection = await pullCloudBotModelSelection({
      botId: '43',
      auth,
      fetchImpl: (async () => Response.json({
        uid: 43,
        configured: false,
        desired: { kind: 'local', model_id: 'local', revision: 0 },
      })) as typeof fetch,
    });

    assert.equal(selection, undefined);
  });

  test('acknowledges a local handoff with its revision', async () => {
    let requestBody: any;
    await acknowledgeCloudBotModelSelection({
      botId: '43',
      auth,
      fetchImpl: (async (_input, init) => {
        requestBody = JSON.parse(String(init?.body));
        return Response.json({ status: 'applied' });
      }) as typeof fetch,
    }, { kind: 'local', modelId: 'local', revision: 8 });

    assert.deepStrictEqual(requestBody, {
      revision: 8,
      kind: 'local',
      model_id: 'local',
      reasoning_effort: '',
    });
  });

  test('reads cloud context window for catalog selections from BotDefinition', async () => {
    const selection = await pullCloudBotModelSelection({
      botId: '43',
      auth,
      fetchImpl: (async () => Response.json({
        uid: 43,
        configured: true,
        revision: 9,
        definition: {
          schema: 'xiaoba.bot-definition.v1',
          botId: '43',
          model: { kind: 'catalog', modelId: 'gpt-5.6-sol', contextWindowTokens: 256000 },
        },
      })) as typeof fetch,
    });

    assert.deepStrictEqual(selection, {
      kind: 'catalog',
      modelId: 'gpt-5.6-sol',
      contextWindowTokens: 256000,
      revision: 9,
      definition: {
        schema: 'xiaoba.bot-definition.v1',
        botId: '43',
        model: { kind: 'catalog', modelId: 'gpt-5.6-sol', contextWindowTokens: 256000 },
      },
    });
  });

  test('reads cloud context window from the legacy model-config contract', async () => {
    const selection = await pullCloudBotModelSelection({
      botId: '43',
      auth,
      fetchImpl: (async () => Response.json({
        uid: 43,
        configured: true,
        desired: {
          kind: 'catalog', model_id: 'gpt-5.6-sol', revision: 10,
          context_window_tokens: 256000,
        },
      })) as typeof fetch,
    });

    assert.deepStrictEqual(selection, {
      kind: 'catalog',
      modelId: 'gpt-5.6-sol',
      contextWindowTokens: 256000,
      revision: 10,
    });
  });
});
