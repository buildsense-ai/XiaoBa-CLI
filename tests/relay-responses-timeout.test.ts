import { test } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { OpenAIProvider } from '../src/providers/openai-provider';

function provider(url = 'https://relay.catsco.cc/v1'): any {
  return new OpenAIProvider({ apiUrl: url, apiKey: 'test-key', model: 'gpt-test', openaiApiMode: 'responses' });
}

test('Relay deadline defaults cover both domains but never lookalike origins', () => {
  const saved = process.env.XIAOBA_RESPONSES_HEADERS_TIMEOUT_MS;
  try {
    delete process.env.XIAOBA_RESPONSES_HEADERS_TIMEOUT_MS;
    for (const host of ['relay.catsco.cc', 'relay.catsco.cn']) {
      assert.equal(provider(`https://${host}/openai/v1`).responsesHeadersTimeoutMs(), 660_000);
    }
    for (const url of ['https://example.test/v1', 'http://relay.catsco.cc/v1',
      'https://relay.catsco.cc.attacker.test/v1', 'https://relay.catsco.cc:444/v1']) {
      assert.equal(provider(url).responsesHeadersTimeoutMs(), 120_000);
    }
    for (const value of ['', 'invalid', 'Infinity']) {
      process.env.XIAOBA_RESPONSES_HEADERS_TIMEOUT_MS = value;
      assert.equal(provider().responsesHeadersTimeoutMs(), 660_000);
    }
    for (const [value, expected] of [['0', 0], ['-1', 0], ['5', 5], ['900000', 660_000]] as const) {
      process.env.XIAOBA_RESPONSES_HEADERS_TIMEOUT_MS = value;
      assert.equal(provider().responsesHeadersTimeoutMs(), expected);
    }
    assert.equal(provider('https://example.test/v1').responsesHeadersTimeoutMs(), 600_000);
  } finally {
    if (saved === undefined) delete process.env.XIAOBA_RESPONSES_HEADERS_TIMEOUT_MS;
    else process.env.XIAOBA_RESPONSES_HEADERS_TIMEOUT_MS = saved;
  }
});

for (const stream of [true, false]) {
  test(`Relay ${stream ? 'SSE headers' : 'JSON completion'} survives 144s failover and cleans timer`, async (t) => {
    const saved = process.env.XIAOBA_RESPONSES_HEADERS_TIMEOUT_MS;
    const originalPost = axios.post;
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let signal: AbortSignal | undefined;
    try {
      delete process.env.XIAOBA_RESPONSES_HEADERS_TIMEOUT_MS;
      (axios as any).post = async (_url: string, _body: unknown, config: any) => {
        signal = config.signal;
        return new Promise((resolve, reject) => {
          signal!.addEventListener('abort', () => reject(new Error('unexpected abort')), { once: true });
          setTimeout(() => resolve({ data: 'completed', headers: {} }), 144_231);
        });
      };
      const p = provider();
      const result = p.postProviderRequest(p.responsesUrl, {}, stream);
      t.mock.timers.tick(120_001);
      assert.equal(signal?.aborted, false);
      t.mock.timers.tick(24_230);
      assert.equal((await result).data, 'completed');
      t.mock.timers.tick(660_000);
      assert.equal(signal?.aborted, false, 'completed request watchdog must be cleared');
    } finally {
      (axios as any).post = originalPost;
      if (saved === undefined) delete process.env.XIAOBA_RESPONSES_HEADERS_TIMEOUT_MS;
      else process.env.XIAOBA_RESPONSES_HEADERS_TIMEOUT_MS = saved;
      t.mock.timers.reset();
    }
  });

  for (const cancel of [false, true]) {
    test(`Relay ${stream ? 'SSE' : 'JSON'} ${cancel ? 'user cancellation remains immediate' : 'still has a finite deadline'}`, async (t) => {
      const saved = process.env.XIAOBA_RESPONSES_HEADERS_TIMEOUT_MS;
      const originalPost = axios.post;
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const controller = new AbortController();
      try {
        delete process.env.XIAOBA_RESPONSES_HEADERS_TIMEOUT_MS;
        (axios as any).post = async (_url: string, _body: unknown, config: any) => new Promise((_resolve, reject) => {
          config.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'ERR_CANCELED' })), { once: true });
        });
        const p = provider('https://relay.catsco.cn/v1');
        const result = p.postProviderRequest(p.responsesUrl, {}, stream, { signal: controller.signal });
        const rejected = assert.rejects(result, (error: any) => error.code === (cancel ? 'ERR_CANCELED' : 'XIAOBA_RESPONSES_HEADERS_TIMEOUT'));
        if (cancel) controller.abort();
        else t.mock.timers.tick(660_000);
        await rejected;
      } finally {
        (axios as any).post = originalPost;
        if (saved === undefined) delete process.env.XIAOBA_RESPONSES_HEADERS_TIMEOUT_MS;
        else process.env.XIAOBA_RESPONSES_HEADERS_TIMEOUT_MS = saved;
        t.mock.timers.reset();
      }
    });
  }
}
