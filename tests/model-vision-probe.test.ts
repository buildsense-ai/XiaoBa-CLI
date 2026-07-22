import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { probeVisionCapability } from '../src/utils/model-vision-probe';

describe('model vision capability probe', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  test('probes OpenAI Responses once and reuses the persisted result', async () => {
    const cachePath = createCachePath(roots);
    let requests = 0;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      requests += 1;
      assert.equal(new URL(String(input)).pathname, '/v1/responses');
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer sk-responses-secret');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, 'future-multimodal-model');
      assert.match(body.input[0].content[1].image_url, /^data:image\/png;base64,/);
      return Response.json({ output_text: '731' });
    }) as typeof fetch;
    const config = {
      provider: 'openai' as const,
      openaiApiMode: 'responses' as const,
      apiUrl: 'https://models.example.test/v1',
      apiKey: 'sk-responses-secret',
      model: 'future-multimodal-model',
    };

    assert.equal(await probeVisionCapability(config, { fetchImpl, cachePath, probeImageBase64: 'cHJvYmU=' }), 'supported');
    assert.equal(await probeVisionCapability(config, { fetchImpl, cachePath, probeImageBase64: 'cHJvYmU=' }), 'supported');
    assert.equal(requests, 1);
    assert.equal(fs.readFileSync(cachePath, 'utf8').includes(config.apiKey), false);
  });

  test('generates its small probe image from the packaged PDF canvas dependency', async () => {
    const cachePath = createCachePath(roots);
    let encodedImage = '';
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      encodedImage = body.input[0].content[1].image_url;
      return Response.json({ output_text: '731' });
    }) as typeof fetch;

    const state = await probeVisionCapability({
      provider: 'openai',
      openaiApiMode: 'responses',
      apiUrl: 'https://models.example.test/v1',
      apiKey: 'sk-generated-probe',
      model: 'generated-probe-model',
    }, { fetchImpl, cachePath });

    assert.equal(state, 'supported');
    assert.match(encodedImage, /^data:image\/png;base64,/);
    assert.ok(encodedImage.length > 200);
  });

  test('only records unsupported when the endpoint explicitly rejects image input', async () => {
    const cachePath = createCachePath(roots);
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(new URL(String(input)).pathname, '/v1/chat/completions');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.messages[0].content[1].type, 'image_url');
      return Response.json({ error: { message: 'This model does not support image input.' } }, { status: 400 });
    }) as typeof fetch;

    const state = await probeVisionCapability({
      provider: 'openai',
      openaiApiMode: 'chat_completions',
      apiUrl: 'https://models.example.test/v1',
      apiKey: 'sk-chat-secret',
      model: 'text-only-custom',
    }, { fetchImpl, cachePath, probeImageBase64: 'cHJvYmU=' });

    assert.equal(state, 'unsupported');
  });

  test('keeps authentication and rate-limit failures unknown', async () => {
    for (const status of [401, 429]) {
      const cachePath = createCachePath(roots);
      const apiKey = `sk-anthropic-${status}`;
      const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        assert.equal(new URL(String(input)).pathname, '/v1/messages');
        assert.equal(new Headers(init?.headers).get('x-api-key'), apiKey);
        const body = JSON.parse(String(init?.body));
        assert.equal(body.messages[0].content[1].type, 'image');
        return Response.json({ error: { message: status === 401 ? 'invalid key' : 'rate limited' } }, { status });
      }) as typeof fetch;

      const state = await probeVisionCapability({
        provider: 'anthropic',
        apiUrl: 'https://models.example.test/anthropic',
        apiKey,
        model: `custom-${status}`,
      }, { fetchImpl, cachePath, probeImageBase64: 'cHJvYmU=' });

      assert.equal(state, 'unknown');
      assert.equal(fs.readFileSync(cachePath, 'utf8').includes(apiKey), false);
    }
  });

  test('keeps a successful but inconclusive answer unknown', async () => {
    const cachePath = createCachePath(roots);
    const fetchImpl = (async () => Response.json({ choices: [{ message: { content: 'I cannot tell.' } }] })) as typeof fetch;
    const state = await probeVisionCapability({
      provider: 'openai',
      apiUrl: 'https://models.example.test/v1',
      apiKey: 'sk-inconclusive',
      model: 'ambiguous-model',
    }, { fetchImpl, cachePath, probeImageBase64: 'cHJvYmU=' });
    assert.equal(state, 'unknown');
  });
});

function createCachePath(roots: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-vision-probe-'));
  roots.push(root);
  return path.join(root, 'model-capability-cache.json');
}
