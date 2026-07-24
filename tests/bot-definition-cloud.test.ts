import { afterEach, beforeEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BOT_DEFINITION_SCHEMA, type BotDefinition } from '../src/bot-definition/types';
import {
  BotDefinitionCloudError,
  HttpBotDefinitionCloudClient,
} from '../src/bot-skills/definition-cloud';
import { FileBotDefinitionCloudClient } from '../src/bot-skills/file-definition-cloud';

describe('Bot Definition cloud contract', () => {
  let root: string;
  const definition: BotDefinition = {
    schema: BOT_DEFINITION_SCHEMA,
    botId: 'bot-a',
    model: { kind: 'catalog', modelId: 'model-a' },
    skills: [{ skillId: 'private/a', version: '1' }],
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-definition-cloud-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('file cloud distinguishes 404, creates once, and enforces strong ETag on field-level PATCH', async () => {
    const cloud = new FileBotDefinitionCloudClient({ root, botId: 'bot-a' });
    assert.deepStrictEqual(await cloud.read(), { kind: 'missing' });

    const created = await cloud.create(definition);
    assert.equal(created.etag, '"definition-1"');
    await assert.rejects(
      cloud.create(definition),
      (error: any) => error instanceof BotDefinitionCloudError && error.status === 412,
    );
    await assert.rejects(
      cloud.patchSkills([], '"definition-stale"'),
      (error: any) => error.status === 412,
    );

    const patched = await cloud.patchSkills([], created.etag);
    assert.equal(patched.etag, '"definition-2"');
    assert.deepStrictEqual(patched.definition.skills, []);
    assert.deepStrictEqual(patched.definition.model, definition.model);
  });

  test('file cloud reports corrupt storage as an error instead of a missing Definition', async () => {
    const cloud = new FileBotDefinitionCloudClient({ root, botId: 'bot-a' });
    fs.mkdirSync(path.dirname(cloud.getPath()), { recursive: true });
    fs.writeFileSync(cloud.getPath(), '{broken');

    await assert.rejects(
      cloud.read(),
      (error: any) => error.code === 'BOT_DEFINITION_STORAGE_CORRUPT',
    );
  });

  test('HTTP cloud sends Bot API Key and conditional headers without accepting weak/missing ETags', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      requests.push({ url: String(url), init });
      if (init?.method === 'GET') {
        return new Response(JSON.stringify(definition), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ETag: '"definition-7"' },
        });
      }
      return new Response(JSON.stringify({
        ...definition,
        skills: [],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ETag: '"definition-8"' },
      });
    };
    const cloud = new HttpBotDefinitionCloudClient({
      botId: 'bot-a',
      auth: {
        apiKey: 'bot-secret',
        httpBaseUrl: 'https://cats.example',
        serverUrl: 'wss://cats.example',
      },
      fetchImpl,
    });

    const read = await cloud.read();
    assert.equal(read.kind, 'found');
    await cloud.patchSkills([], '"definition-7"');
    assert.equal((requests[0].init?.headers as any).Authorization, 'ApiKey bot-secret');
    assert.equal((requests[1].init?.headers as any)['If-Match'], '"definition-7"');
    assert.deepStrictEqual(JSON.parse(String(requests[1].init?.body)), { skills: [] });

    const invalidCloud = new HttpBotDefinitionCloudClient({
      botId: 'bot-a',
      auth: {
        apiKey: 'bot-secret',
        httpBaseUrl: 'https://cats.example',
        serverUrl: 'wss://cats.example',
      },
      fetchImpl: async () => new Response(JSON.stringify(definition), { status: 200 }),
    });
    await assert.rejects(
      invalidCloud.read(),
      (error: any) => error.code === 'BOT_DEFINITION_ETAG_INVALID',
    );
  });

  test('HTTP create sends only the server-owned skills field and does not overwrite model or prompt', async () => {
    let requestBody: unknown;
    const cloud = new HttpBotDefinitionCloudClient({
      botId: 'bot-a',
      auth: {
        apiKey: 'bot-secret',
        httpBaseUrl: 'https://cats.example',
        serverUrl: 'wss://cats.example',
      },
      fetchImpl: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({
          ...definition,
          prompt: { selected: 'custom', customSystemPrompt: 'server-owned prompt' },
        }), {
          status: 201,
          headers: { 'Content-Type': 'application/json', ETag: '"definition-9"' },
        });
      },
    });

    await cloud.create({
      ...definition,
      prompt: { selected: 'custom', customSystemPrompt: 'local prompt' },
    });

    assert.deepStrictEqual(requestBody, { skills: definition.skills });
  });

  test('HTTP cloud treats only an explicit 404 as missing', async () => {
    const cloud404 = new HttpBotDefinitionCloudClient({
      botId: 'bot-a',
      auth: { apiKey: 'key', httpBaseUrl: 'https://cats.example', serverUrl: '' },
      fetchImpl: async () => new Response('', { status: 404 }),
    });
    assert.deepStrictEqual(await cloud404.read(), { kind: 'missing' });

    const cloud500 = new HttpBotDefinitionCloudClient({
      botId: 'bot-a',
      auth: { apiKey: 'key', httpBaseUrl: 'https://cats.example', serverUrl: '' },
      fetchImpl: async () => new Response('failed', { status: 500 }),
    });
    await assert.rejects(
      cloud500.read(),
      (error: any) => error.status === 500,
    );
  });

  test('HTTP cloud migrates an existing legacy Bot through revision-zero PATCH', async () => {
    const requests: RequestInit[] = [];
    const cloud = new HttpBotDefinitionCloudClient({
      botId: 'bot-a',
      auth: { apiKey: 'key', httpBaseUrl: 'https://cats.example', serverUrl: '' },
      fetchImpl: async (_url, init) => {
        requests.push(init || {});
        if (init?.method === 'GET') {
          return new Response(JSON.stringify({
            schema: BOT_DEFINITION_SCHEMA,
            botId: 'bot-a',
            model: { kind: 'catalog', modelId: 'model-a' },
          }), {
            status: 200,
            headers: { ETag: '"bot-definition-1-m3-s0"' },
          });
        }
        return new Response(JSON.stringify({
          schema: BOT_DEFINITION_SCHEMA,
          botId: 'bot-a',
          model: { kind: 'catalog', modelId: 'model-a' },
          skills: [],
        }), {
          status: 200,
          headers: { ETag: '"bot-definition-1-m3-s1"' },
        });
      },
    });

    const legacy = await cloud.read();
    assert.equal(legacy.kind, 'found');
    assert.equal(legacy.kind === 'found' && legacy.definition.skills, undefined);
    await cloud.patchSkills([], legacy.kind === 'found' ? legacy.etag : '');
    assert.equal((requests[1].headers as any)['If-Match'], '"bot-definition-1-m3-s0"');
  });
});
