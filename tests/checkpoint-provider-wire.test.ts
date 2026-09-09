import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { OpenAIProvider } from '../src/providers/openai-provider';
import { CheckpointCompactionCoordinator } from '../src/core/checkpoint-compaction';
import type { Message } from '../src/types';

for (const mode of ['responses', 'chat_completions'] as const) {
  test(`checkpoint historical tools remain quoted data on the ${mode} HTTP wire`, { timeout: 10000 }, async () => {
    const requests: any[] = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (mode === 'responses') {
        res.end(`data: ${JSON.stringify({ type: 'response.completed', response: {
          id: 'resp-checkpoint', status: 'completed', output: [{ type: 'message', role: 'assistant',
            content: [{ type: 'output_text', text: 'Verified progress; inspect original files before continuing.' }] }],
        } })}\n\n`);
      } else {
        res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Verified progress; inspect original files before continuing.' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as { port: number };
    try {
      const provider = new OpenAIProvider({ apiKey: 'local-test-only', apiUrl: `http://127.0.0.1:${address.port}/v1`, model: 'test-model', openaiApiMode: mode });
      const coordinator = new CheckpointCompactionCoordinator(provider as any, { maxContextTokens: 200 });
      const history: Message[] = [{ role: 'assistant', content: 'Historical execution evidence. '.repeat(1000),
        tool_calls: [{ id: 'old-call', type: 'function', function: { name: 'execute_shell', arguments: '{"command":"DONT_EXECUTE_MARKER"}' } }],
        providerContent: [{ type: 'tool_use', id: 'old-call', name: 'execute_shell', input: { command: 'DONT_EXECUTE_MARKER' } }],
      }];
      const result = await coordinator.compactIfNeeded(history, { sessionKey: `wire-${mode}`, phase: 'mid_turn' });
      assert.equal(result.compacted, true);
      assert.equal(requests.length, 1);
      const wire = requests[0];
      assert.ok(!wire.tools || wire.tools.length === 0);
      const inputs = mode === 'responses' ? wire.input : wire.messages.filter((message: any) => message.role !== 'system');
      assert.ok(inputs.length > 0);
      assert.ok(inputs.every((item: any) => item.role === 'user' && !item.tool_calls && !item.tool_call_id && !item.providerContent));
      assert.match(JSON.stringify(inputs), /DONT_EXECUTE_MARKER/);
      assert.match(JSON.stringify(inputs.at(-1)), /Produce the continuation checkpoint/);
      assert.equal(history[0].tool_calls?.[0].id, 'old-call');
    } finally {
      const closed = once(server, 'close');
      server.close();
      server.closeAllConnections();
      await closed;
    }
  });
}
