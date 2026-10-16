/**
 * 回填去重：自己已经发过的回复不该被当成远端上下文再插一次。
 *
 * 实测同一句回复会在同一段历史里相邻出现两遍。去重键是 `source:id`，而本机
 * 生成的回复没有 __remoteContextId，认不出回填回来的就是自己那条。
 */
import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import {
  collectLocalAssistantTexts,
  isDuplicateDurableContextEntry,
  type DurableContextDedupState,
} from '../src/core/durable-context-dedup';
import type { Message } from '../src/types';

function state(overrides: Partial<DurableContextDedupState> = {}): DurableContextDedupState {
  return {
    knownRemoteIds: new Set<string>(),
    watermarks: {},
    localAssistantTexts: new Set<string>(),
    ...overrides,
  };
}

describe('回填去重', () => {
  test('本机已发出的回复不再回填', () => {
    const messages: Message[] = [
      { role: 'user', content: '[发言人: Lin（人）]\nhi' },
      { role: 'assistant', content: 'Hi Lin! 👋 有什么可以帮你的吗？' },
    ];
    const dedup = state({ localAssistantTexts: collectLocalAssistantTexts(messages) });

    assert.equal(
      isDuplicateDurableContextEntry(
        { role: 'assistant', content: 'Hi Lin! 👋 有什么可以帮你的吗？', source: 'catscompany.agent_context', id: 1444586 },
        dedup,
      ),
      true,
      '本地已有的同一句回复应被跳过',
    );
  });

  test('真正错过的回复仍然收下', () => {
    // 本机没有这条——例如发出后进程就挂了。恢复语义不能变。
    const dedup = state({ localAssistantTexts: collectLocalAssistantTexts([]) });

    assert.equal(
      isDuplicateDurableContextEntry(
        { role: 'assistant', content: '上一轮由当前 Agent 发出的回复', source: 'catscompany.agent_context', id: 11 },
        dedup,
      ),
      false,
    );
  });

  test('同伴的消息不受影响', () => {
    // 同伴消息渲染时带 [发言人: …（bot）] 前缀，不会和本机裸回复撞上；
    // 即便正文恰好相同，也只按 role=assistant 的本地集合判重。
    const messages: Message[] = [
      { role: 'assistant', content: '我处理完了' },
    ];
    const dedup = state({ localAssistantTexts: collectLocalAssistantTexts(messages) });

    assert.equal(
      isDuplicateDurableContextEntry(
        { role: 'user', content: '[发言人: 阿码（bot）]\n我处理完了', source: 'catscompany.agent_context', id: 30 },
        dedup,
      ),
      false,
      '同伴消息带发言人前缀，不该被误判',
    );
  });

  test('已见过的远端 id 仍然按原规则去重', () => {
    const dedup = state({ knownRemoteIds: new Set(['catscompany.agent_context:100']) });

    assert.equal(
      isDuplicateDurableContextEntry({ content: '之前的消息', source: 'catscompany.agent_context', id: 100 }, dedup),
      true,
    );
  });

  test('低于高水位的远端 id 仍然被挡住', () => {
    const dedup = state({ watermarks: { 'catscompany.agent_context': 500 } });

    assert.equal(
      isDuplicateDurableContextEntry({ content: '更早的消息', source: 'catscompany.agent_context', id: 400 }, dedup),
      true,
    );
    assert.equal(
      isDuplicateDurableContextEntry({ content: '更新的消息', source: 'catscompany.agent_context', id: 600 }, dedup),
      false,
    );
  });

  test('同一批里重复出现的条目只保留一条', () => {
    const dedup = state();
    const entry = { content: '同一条', source: 'catscompany.agent_context', id: 700 };

    assert.equal(isDuplicateDurableContextEntry(entry, dedup), false, '第一次保留');
    assert.equal(isDuplicateDurableContextEntry({ ...entry }, dedup), true, '第二次跳过');
  });

  test('没有 id 的纯文本条目照常放行', () => {
    const dedup = state();
    assert.equal(isDuplicateDurableContextEntry({ content: '一段上下文' }, dedup), false);
  });

  test('远端 assistant 条目不参与本地文本比对', () => {
    // 已经带 __remoteContextSource 的 assistant 不是"本机发出的"，不进集合。
    const messages: Message[] = [
      { role: 'assistant', content: '远端回填来的', __remoteContextSource: 'catscompany.agent_context', __remoteContextId: 9 },
    ];
    const texts = collectLocalAssistantTexts(messages);
    assert.equal(texts.size, 0, '远端回填的 assistant 不算本机发出');
  });
});
