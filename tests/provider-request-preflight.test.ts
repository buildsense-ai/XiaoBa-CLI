import test from 'node:test';
import assert from 'node:assert/strict';
import type { Message } from '../src/types';
import { prepareProviderRequestMessages } from '../src/providers/request-preflight';

function toolCall(id: string, name = 'lookup', args = '{"q":"cats"}') {
  return { id, type: 'function' as const, function: { name, arguments: args } };
}

test('valid tool exchanges pass preflight without cloning the request', () => {
  const messages: Message[] = [
    { role: 'user', content: 'find cats' },
    { role: 'assistant', content: null, tool_calls: [toolCall('call_1')] },
    { role: 'tool', tool_call_id: 'call_1', name: 'lookup', content: 'cats' },
  ];

  const result = prepareProviderRequestMessages(messages);

  assert.equal(result.messages, messages);
  assert.equal(result.summary, undefined);
});

test('preflight keeps only contiguous one-to-one tool call/result pairs', () => {
  const messages: Message[] = [
    { role: 'user', content: 'find cats' },
    {
      role: 'assistant',
      content: 'checking',
      tool_calls: [
        toolCall('call_1'),
        toolCall('call_2'),
        toolCall('', 'broken'),
      ],
      providerContent: [
        { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque' },
        { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q":"cats"}' },
        { type: 'function_call', call_id: 'call_2', name: 'lookup', arguments: '{"q":"cats"}' },
      ],
      providerState: {
        schema: 'xiaoba.provider_state.v1',
        apiType: 'openai-responses',
        model: 'gpt-test',
        endpointFingerprint: '0123456789abcdef',
      },
    },
    { role: 'tool', tool_call_id: 'call_1', name: 'lookup', content: 'cats' },
    { role: 'tool', tool_call_id: 'call_1', name: 'lookup', content: 'duplicate' },
    { role: 'tool', tool_call_id: 'unknown', name: 'lookup', content: 'orphan' },
    { role: 'user', content: 'continue' },
    { role: 'tool', tool_call_id: 'call_2', name: 'lookup', content: 'too late' },
  ];

  const result = prepareProviderRequestMessages(messages);

  assert.deepEqual(result.messages.map(message => message.role), ['user', 'assistant', 'tool', 'user']);
  assert.deepEqual(result.messages[1].tool_calls?.map(call => call.id), ['call_1']);
  assert.equal(result.messages[1].providerContent, undefined);
  assert.equal(result.messages[1].providerState, undefined);
  assert.deepEqual(result.summary, {
    repaired: true,
    issueCodes: [
      'duplicate_tool_result',
      'invalid_tool_call',
      'missing_tool_result',
      'orphan_tool_result',
      'provider_replay_mismatch',
    ],
    droppedMessages: 3,
    droppedToolCalls: 2,
    droppedToolResults: 3,
    providerReplayFallbacks: 1,
  });
});

test('preflight falls back from mismatched opaque replay without losing canonical tools', () => {
  const state = {
    schema: 'xiaoba.provider_state.v1' as const,
    apiType: 'anthropic-messages' as const,
    model: 'claude-test',
    endpointFingerprint: '0123456789abcdef',
  };
  const messages: Message[] = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [toolCall('call_1', 'lookup', '{"a":1,"b":2}')],
      providerContent: [
        { type: 'thinking', thinking: 'opaque', signature: 'sig' },
        { type: 'tool_use', id: 'call_1', name: 'wrong_name', input: { b: 2, a: 1 } },
      ],
      providerState: state,
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
  ];

  const result = prepareProviderRequestMessages(messages);

  assert.equal(result.messages[0].tool_calls?.[0].id, 'call_1');
  assert.equal(result.messages[0].providerContent, undefined);
  assert.equal(result.messages[0].providerState, undefined);
  assert.deepEqual(result.summary?.issueCodes, ['provider_replay_mismatch']);
});

test('matching opaque replay survives normalized JSON argument comparison', () => {
  const messages: Message[] = [
    {
      role: 'assistant',
      content: null,
      tool_calls: [toolCall('call_1', 'lookup', '{"a":1,"b":2}')],
      providerContent: [
        { type: 'thinking', thinking: 'opaque', signature: 'sig' },
        { type: 'tool_use', id: 'call_1', name: 'lookup', input: { b: 2, a: 1 } },
      ],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
  ];

  const result = prepareProviderRequestMessages(messages);

  assert.equal(result.messages, messages);
  assert.equal(result.summary, undefined);
});

test('interrupted exchanges and empty tool call arrays are repaired locally', () => {
  const messages: Message[] = [
    { role: 'assistant', content: null, tool_calls: [toolCall('call_1')] },
    { role: 'user', content: 'new topic' },
    { role: 'tool', tool_call_id: 'call_1', content: 'late result' },
    { role: 'assistant', content: 'done', tool_calls: [] },
  ];

  const result = prepareProviderRequestMessages(messages);

  assert.deepEqual(result.messages, [
    { role: 'user', content: 'new topic' },
    { role: 'assistant', content: 'done', tool_calls: undefined },
  ]);
  assert.deepEqual(result.summary?.issueCodes, [
    'empty_tool_calls',
    'missing_tool_result',
    'orphan_tool_result',
  ]);
});

test('preflight normalizes padded tool exchange IDs without dropping the pair', () => {
  const messages: Message[] = [
    { role: 'assistant', content: null, tool_calls: [toolCall(' call_1 ')] },
    { role: 'tool', tool_call_id: ' call_1 ', content: 'ok' },
  ];

  const result = prepareProviderRequestMessages(messages);

  assert.notEqual(result.messages, messages);
  assert.equal(result.messages[0].tool_calls?.[0].id, 'call_1');
  assert.equal(result.messages[1].tool_call_id, 'call_1');
  assert.deepEqual(result.summary, {
    repaired: true,
    issueCodes: ['normalized_tool_exchange_id'],
    droppedMessages: 0,
    droppedToolCalls: 0,
    droppedToolResults: 0,
    providerReplayFallbacks: 0,
  });
});

test('sanitized restored Responses history preserves all 16 canonical tool pairs', () => {
  const messages: Message[] = [
    { role: 'user', content: 'checkpoint one' },
    { role: 'assistant', content: 'ack one' },
    { role: 'user', content: 'checkpoint two' },
    { role: 'assistant', content: 'ack two' },
    { role: 'user', content: 'checkpoint three' },
    { role: 'assistant', content: 'ack three' },
    { role: 'user', content: 'checkpoint four' },
    { role: 'user', content: 'checkpoint five' },
  ];
  let callNumber = 0;
  for (let exchange = 0; exchange < 10; exchange++) {
    const calls = Array.from({ length: exchange < 6 ? 2 : 1 }, () => {
      callNumber++;
      return toolCall(`call_${callNumber}`, 'lookup', JSON.stringify({ item: callNumber }));
    });
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: calls,
      providerContent: [
        { type: 'reasoning', id: `reasoning_${exchange + 1}`, encrypted_content: 'opaque' },
      ],
    });
    for (const call of calls) {
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.function.name,
        content: `result ${call.id}`,
      });
    }
  }
  assert.equal(messages.length, 34);
  assert.equal(callNumber, 16);

  const result = prepareProviderRequestMessages(messages);
  const retainedCalls = result.messages.flatMap(message => message.tool_calls || []);
  const retainedResults = result.messages.filter(message => message.role === 'tool');
  const retainedCallIds = new Set(retainedCalls.map(call => call.id));

  assert.equal(result.messages.length, 34);
  assert.equal(retainedCalls.length, 16);
  assert.equal(retainedResults.length, 16);
  assert.equal(retainedCallIds.size, 16);
  assert.ok(retainedResults.every(message => retainedCallIds.has(String(message.tool_call_id))));
  assert.ok(result.messages
    .filter(message => message.role === 'assistant' && message.tool_calls?.length)
    .every(message => message.providerContent === undefined));
  assert.deepEqual(result.summary, {
    repaired: true,
    issueCodes: ['provider_replay_mismatch'],
    droppedMessages: 0,
    droppedToolCalls: 0,
    droppedToolResults: 0,
    providerReplayFallbacks: 10,
  });
});
