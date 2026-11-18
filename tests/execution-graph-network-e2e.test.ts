import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { ConversationRunner } from '../src/core/conversation-runner';
import { OpenAIProvider } from '../src/providers/openai-provider';
import type { Message } from '../src/types';
import type { ToolDefinition } from '../src/types/tool';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('E2E: ordinary provider HTTP request and successful-call manifest share exact dispatch inputs', { timeout: 10000 }, async () => {
  const captured: any[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    captured.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'captured response' }, finish_reason: 'stop' }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  const tool: ToolDefinition = { name: 'lookup', description: 'Look up a value', parameters: { type: 'object', properties: { key: { type: 'string' } } } };
  const provider = new OpenAIProvider({ apiKey: 'local-test-only', apiUrl: `http://127.0.0.1:${address.port}/v1`, model: 'capture-test' });
  const runner = new ConversationRunner(provider as any, {
    getToolDefinitions: () => [tool], executeTool: async () => { throw new Error('this response has no tool call'); },
  } as any, { stream: false, episodeId: 'network-episode', toolExecutionContext: { sessionId: 'network-session' } });
  const events: any[] = [];
  try {
    const input: Message[] = [
      { role: 'system', content: 'Use only the declared tools.' },
      { role: 'user', content: 'Find the value for key alpha.', __episodeId: 'network-episode', __episodeInputKind: 'root' },
    ];
    const result = await runner.run(input, { onExecutionGraphEvent: event => events.push(event) } as any);
    assert.equal(result.response, 'captured response');
    assert.equal(captured.length, 1);
    assert.equal(events.length, 1);

    const wire = captured[0];
    const event = events[0];
    const wireItems = wire.messages.map((message: any) => ({
      role: message.role,
      content: message.content,
      tool_calls: message.tool_calls,
      tool_call_id: message.tool_call_id,
    }));
    const manifest = event.input_manifest;
    assert.equal(manifest.complete, true);
    assert.equal(manifest.tools_complete, true);
    assert.equal(manifest.items.length, wireItems.length);
    for (const item of manifest.items) {
      const wireRole = item.kind === 'prompt' || item.kind === 'runtime_material' ? 'system'
        : item.kind === 'query' ? 'user' : item.kind;
      const matching = wireItems.find((message: any) => message.role === wireRole && hash(message) === item.sha256);
      assert.ok(matching, `submitted manifest item ${item.kind}/${item.ref} must match the actual HTTP request`);
      assert.equal(item.identity_state, item.kind === 'prompt' ? 'client_prompt_material' : 'client_session_node');
    }
    assert.deepEqual(manifest.items.map((item: any) => item.kind), ['prompt', 'query']);
    assert.equal(manifest.tools[0].name, wire.tools[0].function.name);
    assert.equal(manifest.tools[0].schema_sha256, hash({
      description: wire.tools[0].function.description,
      parameters: wire.tools[0].function.parameters,
    }));
    assert.equal(event.outputs_complete, true);
    assert.equal(event.status, 'succeeded');
    assert.equal(JSON.stringify(event).includes('Use only the declared tools.'), false);
  } finally {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  }
});
