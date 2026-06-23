import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TRANSIENT_VISIBLE_OUTPUT_GUIDANCE_PREFIX,
  buildVisibleOutputGuidance,
} from '../src/core/visible-output-guidance';
import {
  resolveProviderTransientPolicy,
} from '../src/core/transient-injection-policy';
import { ConversationRunner } from '../src/core/conversation-runner';
import { TurnContextBuilder } from '../src/core/turn-context-builder';
import type { Message } from '../src/types';
import type { ToolDefinition, ToolExecutor } from '../src/types/tool';

function tool(name: string): ToolDefinition {
  return {
    name,
    description: `${name} description`,
    parameters: {
      type: 'object',
      properties: {},
    },
  };
}

const artifactTools = [
  tool('write_file'),
  tool('send_file'),
  tool('read_file'),
];

test('visible output guidance describes product preference without hard output enforcement', () => {
  const messages: Message[] = [
    { role: 'user', content: '帮我整理一份完整报告' },
  ];
  const policy = resolveProviderTransientPolicy({
    messages,
    tools: artifactTools,
    turn: 1,
    executedToolCalls: 0,
    surface: 'feishu',
  });

  assert.equal(policy.injectVisibleOutputGuidance, true);
  assert.ok(policy.reasons.includes('visible-output-preference'));

  const guidance = buildVisibleOutputGuidance({
    surface: 'feishu',
    tools: artifactTools,
    intent: policy.intent,
  });

  assert.ok(guidance);
  assert.equal(guidance.role, 'user');
  assert.equal(guidance.__injected, true);
  assert.equal(typeof guidance.content, 'string');
  assert.equal(guidance.content.startsWith(TRANSIENT_VISIBLE_OUTPUT_GUIDANCE_PREFIX), true);
  assert.match(guidance.content, /Keep the chat-visible reply short/);
  assert.match(guidance.content, /write_file/);
  assert.match(guidance.content, /send_file/);
  assert.match(guidance.content, /Example 1: long work product/);
  assert.match(guidance.content, /Assistant action: create or update a Markdown\/document file/);
  assert.match(guidance.content, /Example 2: classroom\/material deliverable/);
  assert.match(guidance.content, /Example 4: explicit inline request/);
  assert.doesNotMatch(guidance.content, /字符数超过|非空行数超过|threshold/i);
});

test('plain chat does not inject visible output guidance', () => {
  const policy = resolveProviderTransientPolicy({
    messages: [{ role: 'user', content: '早，今天状态怎么样？' }],
    tools: artifactTools,
    turn: 1,
    executedToolCalls: 0,
    surface: 'weixin',
  });

  assert.equal(policy.intent.plainChat, true);
  assert.equal(policy.injectVisibleOutputGuidance, false);
});

test('conversation runner injects visible output guidance only into provider input', async () => {
  const executor: ToolExecutor = {
    getToolDefinitions: () => artifactTools,
    executeTool: async () => ({ content: 'unused', role: 'tool', name: 'unused', tool_call_id: 'unused' }),
  };
  let capturedMessages: Message[] = [];
  const aiService = {
    async chat(messages: Message[]) {
      capturedMessages = messages;
      return { content: '我先给你短版结论。' };
    },
  };
  const runner = new ConversationRunner(aiService as any, executor, {
    stream: false,
    enableCompression: false,
    toolExecutionContext: {
      surface: 'feishu',
      workingDirectory: 'C:\\work\\project',
    },
  });

  const result = await runner.run([{ role: 'user', content: '帮我整理一份完整报告' }]);

  const guidance = capturedMessages.find(message =>
    typeof message.content === 'string'
    && message.content.startsWith(TRANSIENT_VISIBLE_OUTPUT_GUIDANCE_PREFIX)
  );
  assert.ok(guidance);
  assert.equal(guidance.role, 'user');
  assert.equal(guidance.__injected, true);
  assert.equal(result.response, '我先给你短版结论。');
  assert.equal(result.messages.some(message =>
    typeof message.content === 'string'
    && message.content.startsWith(TRANSIENT_VISIBLE_OUTPUT_GUIDANCE_PREFIX)
  ), false);
});

test('turn context cleanup removes visible output guidance if it appears in durable messages', () => {
  const builder = new TurnContextBuilder();
  const durable = builder.removeTransientMessages([
    { role: 'system', content: 'base' },
    {
      role: 'user',
      content: `${TRANSIENT_VISIBLE_OUTPUT_GUIDANCE_PREFIX}\nRuntime output preference only.`,
      __injected: true,
    },
    { role: 'user', content: 'real question' },
  ]);

  assert.deepEqual(durable.map(message => message.content), ['base', 'real question']);
});
