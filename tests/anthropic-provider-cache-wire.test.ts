import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { AnthropicProvider } from '../src/providers/anthropic-provider';

test('Anthropic SDK serializes both stable cache breakpoints on the real wire path', async () => {
  let requestBody: any;
  let betaHeader = '';
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      requestBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      betaHeader = String(request.headers['anthropic-beta'] || '');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: 'msg_wire_test',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-20250514',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 30,
          output_tokens: 1,
        },
      }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  try {
    const provider = new AnthropicProvider({
      provider: 'anthropic',
      apiKey: 'test-key',
      apiUrl: 'https://api.anthropic.com/v1/messages',
      model: 'claude-sonnet-4-20250514',
    });
    (provider as any).client.baseURL = `http://127.0.0.1:${address.port}`;

    const result = await provider.chat([
      { role: 'system', content: 'Stable system policy.' },
      { role: 'system', content: '[transient_plan_status]\nrunning', __cacheScope: 'dynamic' },
      { role: 'user', content: 'hello' },
    ], [
      { name: 'zeta', description: 'z', parameters: { type: 'object', properties: {} } },
      { name: 'alpha', description: 'a', parameters: { type: 'object', properties: {} } },
    ]);

    assert.match(betaHeader, /prompt-caching/);
    assert.deepEqual(requestBody.tools.map((tool: any) => tool.name), ['alpha', 'zeta']);
    assert.deepEqual(requestBody.tools[1].cache_control, { type: 'ephemeral' });
    assert.deepEqual(requestBody.system[0].cache_control, { type: 'ephemeral' });
    assert.equal(requestBody.system[1].cache_control, undefined);
    assert.deepEqual(requestBody.messages[0].content[0].cache_control, { type: 'ephemeral' });
    assert.deepEqual(result.usage, {
      promptTokens: 60,
      completionTokens: 1,
      totalTokens: 61,
      inputTokensReported: true,
      providerUsage: {
        contract: 'anthropic-messages-v1',
        input_tokens: 10,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 20,
      },
      cachedReadTokens: 30,
      cacheReadSource: 'anthropic.cache_read_input_tokens',
      cachedWriteTokens: 20,
    });
  } finally {
    server.close();
    await once(server, 'close');
  }
});
