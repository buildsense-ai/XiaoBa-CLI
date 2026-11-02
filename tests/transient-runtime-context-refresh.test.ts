/**
 * transient runtime context 的落位策略。
 *
 * 这份文本每轮都会重建，但多数时候内容没变。旧实现无条件"删旧+追加到末尾"，
 * 内容不变也会挪位置，等于每轮把尾部前缀洗一遍 —— 那一段永远进不了缓存。
 * 这组用例锁住新策略：内容一致原位保留，只有真变了才搬。
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { refreshTransientRuntimeContext } from '../src/core/conversation-runner';
import { TRANSIENT_RUNTIME_CONTEXT_PREFIX } from '../src/core/runtime-context-builder';

type LooseMessage = {
  role: string;
  content: string;
  __cacheScope?: string;
};

const contextMessage = (body: string): LooseMessage => ({
  role: 'system',
  content: `${TRANSIENT_RUNTIME_CONTEXT_PREFIX}\n${body}`,
  __cacheScope: 'dynamic',
});

const userMessage = (text: string): LooseMessage => ({ role: 'user', content: text });

const asMessages = (messages: LooseMessage[]) => messages as unknown as Parameters<
  typeof refreshTransientRuntimeContext
>[0];

const asMessage = (message: LooseMessage | null) =>
  message as unknown as Parameters<typeof refreshTransientRuntimeContext>[1];

test('内容一致时原位保留，不重排尾部', () => {
  const existing = asMessage(contextMessage('device-a'));
  const messages = [asMessage(userMessage('hi')), existing];

  refreshTransientRuntimeContext(asMessages(messages), asMessage(contextMessage('device-a')));

  assert.equal(messages.length, 2);
  // 同一个对象、同一个位置：既没被删掉重建，也没被移到末尾
  assert.equal(messages[1], existing);
});

test('内容变化时才搬到末尾', () => {
  const messages = [asMessage(userMessage('hi')), asMessage(contextMessage('device-a'))];
  const next = asMessage(contextMessage('device-b'));

  refreshTransientRuntimeContext(asMessages(messages), next);

  assert.equal(messages.length, 2);
  assert.equal(messages[1], next);
});

test('历史里堆积的多份副本收敛成一份', () => {
  const messages = [
    asMessage(contextMessage('same')),
    asMessage(userMessage('hi')),
    asMessage(contextMessage('same')),
  ];

  refreshTransientRuntimeContext(asMessages(messages), asMessage(contextMessage('same')));

  const remaining = messages.filter(
    message => typeof message.content === 'string'
      && message.content.startsWith(TRANSIENT_RUNTIME_CONTEXT_PREFIX),
  );
  assert.equal(remaining.length, 1);
});

test('本轮不再需要时整块移除', () => {
  const messages = [asMessage(userMessage('hi')), asMessage(contextMessage('device-a'))];

  refreshTransientRuntimeContext(asMessages(messages), null);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
});
