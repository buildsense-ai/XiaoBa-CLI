import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IN_CONTEXT_DELIVERY_EXAMPLES_PREFIX,
  TRANSIENT_DELIVERY_POLICY_PREFIX,
  buildTransientDeliveryHints,
  resolveDeliveryPolicyDecision,
} from '../src/core/transient-delivery-policy';
import type { Message } from '../src/types';
import type { ToolDefinition } from '../src/types/tool';

function user(content: string): Message[] {
  return [{ role: 'user', content }];
}

const deliveryTools: ToolDefinition[] = [
  {
    name: 'write_file',
    description: 'write file',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'send_file',
    description: 'send file',
    parameters: { type: 'object', properties: {} },
  },
];

test('plain chat does not inject delivery policy', () => {
  const hints = buildTransientDeliveryHints({
    messages: user('你好呀'),
    tools: deliveryTools,
    surface: 'weixin',
    turn: 1,
    executedToolCalls: 0,
  });

  assert.deepEqual(hints, []);
});

test('long artifact-style requests inject examples and delivery policy', () => {
  const hints = buildTransientDeliveryHints({
    messages: user('帮我写一份项目复盘报告，要完整一点'),
    tools: deliveryTools,
    surface: 'weixin',
    turn: 1,
    executedToolCalls: 0,
  });

  assert.equal(hints.length, 2);
  assert.equal(hints[0].role, 'user');
  assert.equal(hints[0].__injected, true);
  assert.equal(String(hints[0].content).startsWith(IN_CONTEXT_DELIVERY_EXAMPLES_PREFIX), true);
  assert.match(String(hints[0].content), /Style examples only/);
  assert.match(String(hints[0].content), /项目复盘报告/);

  assert.equal(hints[1].role, 'user');
  assert.equal(hints[1].__injected, true);
  assert.equal(String(hints[1].content).startsWith(TRANSIENT_DELIVERY_POLICY_PREFIX), true);
  assert.match(String(hints[1].content), /微信短消息/);
  assert.match(String(hints[1].content), /write_file 写入完整材料/);
  assert.match(String(hints[1].content), /不要把全文贴进聊天气泡/);
});

test('coding work requests get a short visible reply contract when tools are available', () => {
  const decision = resolveDeliveryPolicyDecision({
    messages: user('帮我修一下这个登录 bug，顺手跑一下测试'),
    tools: [{
      name: 'read_file',
      description: 'read file',
      parameters: { type: 'object', properties: {} },
    }],
    surface: 'cli',
    turn: 1,
    executedToolCalls: 0,
  });

  assert.equal(decision.inject, true);
  assert.match(decision.reason, /work-result-likely/);
});

test('acknowledgement-only turns do not inject delivery policy', () => {
  const decision = resolveDeliveryPolicyDecision({
    messages: user('好的'),
    tools: deliveryTools,
    surface: 'weixin',
    turn: 1,
    executedToolCalls: 3,
  });

  assert.equal(decision.inject, false);
});
