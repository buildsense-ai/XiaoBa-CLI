import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIProvider } from '../src/providers/openai-provider';
import { isDeepSeekResponses, applyDeepSeekResponsesRequestPolicy } from '../src/providers/deepseek/responses-policy';
import { isPrimaryModelVisionCapable } from '../src/utils/model-capabilities';
import { relayModelIdsMatch } from '../src/utils/relay-model-profiles';

const config = { apiUrl: 'https://api.deepseek.com', apiKey: 'test', model: 'deepseek-flash', openaiApiMode: 'responses' as const };

test('native Flash is a separate selection with Responses and image support', () => {
  assert.equal(isDeepSeekResponses('responses', 'deepseek-flash'), true);
  assert.equal(relayModelIdsMatch('deepseek-flash', 'deepseek-v4-flash'), false);
  assert.equal(isPrimaryModelVisionCapable(config), true);
});

test('ordinary answers preserve scoped plaintext reasoning across the next turn', () => {
  const provider = new OpenAIProvider(config) as any;
  const result = provider.parseResponsesResponse({
    status: 'completed', output: [
      { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'test replay marker' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
    ],
  });
  assert.equal(result.content, 'answer');
  const messages = [{ role: 'assistant', content: result.content, providerContent: result.providerContent, providerState: result.providerState }, { role: 'user', content: 'next' }];
  const wire = provider.buildResponsesRequestBody(messages);
  assert.deepEqual(wire.input.map((item: any) => item.type || item.role), ['reasoning', 'assistant', 'user']);
  assert.equal(wire.input[0].content[0].text, 'test replay marker');
  const other = new OpenAIProvider({ ...config, model: 'gpt-5.6-terra' }) as any;
  assert.equal(JSON.stringify(other.buildResponsesRequestBody(messages)).includes('test replay marker'), false);
});

test('native Flash strips unsupported encrypted state from tool replay', () => {
  const provider = new OpenAIProvider(config) as any;
  const result = provider.parseResponsesResponse({ output: [
    { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'tool replay' }], encrypted_content: 'not-supported' },
    { type: 'function_call', call_id: 'call1', name: 'lookup', arguments: '{}' },
  ] });
  const wire = provider.buildResponsesRequestBody([
    { role: 'assistant', content: null, tool_calls: result.toolCalls, providerContent: result.providerContent, providerState: result.providerState },
    { role: 'tool', tool_call_id: 'call1', content: 'result' },
  ]);
  assert.deepEqual(wire.input.map((item: any) => item.type), ['reasoning', 'function_call', 'function_call_output']);
  assert.equal(JSON.stringify(wire).includes('not-supported'), false);
});

test('forced tool choice is retained only when native thinking is disabled', () => {
  const body: any = { model: 'deepseek-flash', tools: [{ type: 'function', name: 'lookup' }], tool_choice: 'required' };
  applyDeepSeekResponsesRequestPolicy(body, 'low');
  assert.equal(body.tool_choice, 'auto');
  body.tool_choice = 'required';
  applyDeepSeekResponsesRequestPolicy(body, 'disabled');
  assert.equal(body.tool_choice, 'required');
  assert.deepEqual(body.reasoning, { effort: 'none' });
});

test('GPT history keeps completed tool evidence without replaying encrypted reasoning', () => {
  const gpt = new OpenAIProvider({ ...config, model: 'gpt-5.6-terra' }) as any;
  const reply = gpt.parseResponsesResponse({ output: [
    { type: 'reasoning', encrypted_content: 'foreign-encrypted-test-state', summary: [] },
    { type: 'function_call', call_id: 'old_call', name: 'lookup', arguments: '{}' },
  ] });
  const native = new OpenAIProvider(config) as any;
  const wire = native.buildResponsesRequestBody([
    { role: 'assistant', content: null, tool_calls: reply.toolCalls, providerContent: reply.providerContent, providerState: reply.providerState },
    { role: 'tool', tool_call_id: 'old_call', content: 'completed record 5729' },
    { role: 'user', content: 'Continue from the record.' },
  ]);
  assert.equal(JSON.stringify(wire).includes('foreign-encrypted-test-state'), false);
  assert.equal(wire.input[0].type, 'function_call');
  assert.equal(wire.input[1].call_id, 'old_call');
  assert.equal(wire.input[1].output, 'completed record 5729');
});
