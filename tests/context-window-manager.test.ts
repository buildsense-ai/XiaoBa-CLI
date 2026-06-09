import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { ContextWindowManager } from '../src/core/context-window-manager';
import type { Message } from '../src/types';
import type { AIService } from '../src/utils/ai-service';

function system(content: string): Message {
  return { role: 'system', content };
}

function user(content: string): Message {
  return { role: 'user', content };
}

function assistant(content: string): Message {
  return { role: 'assistant', content };
}

describe('ContextWindowManager', () => {
  test('compacts durable transcript without summarizing transient context', async () => {
    let capturedSummaryInput = '';
    const statusEvents: any[] = [];
    const aiService = {
      chatStream: async (messages: Message[], _tools?: any, callbacks?: any) => {
        capturedSummaryInput = messages.map(message => String(message.content || '')).join('\n');
        const content = '<summary>\n旧对话摘要\n</summary>';
        callbacks?.onText?.(content);
        return {
          content,
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        };
      },
    } as unknown as AIService;
    const manager = new ContextWindowManager(aiService, {
      maxContextTokens: 1000,
      compactionThreshold: 0.5,
    });

    const messages: Message[] = [
      system('base system'),
      user('中'.repeat(1400)),
      assistant('durable answer'),
      { role: 'user', content: 'INJECTED_CONTEXT_SHOULD_NOT_BE_SUMMARIZED', __injected: true },
      { role: 'user', content: '[运行时反馈] RUNTIME_FEEDBACK_SHOULD_NOT_BE_SUMMARIZED', __injected: true, __runtimeFeedback: true },
      { role: 'user', content: '[transient_skills_list]\nSKILL_LIST_SHOULD_NOT_BE_SUMMARIZED', __injected: true },
      { role: 'user', content: '[transient_subagent_status]\nSUBAGENT_STATUS_SHOULD_NOT_BE_SUMMARIZED', __injected: true },
    ];

    const result = await manager.compactIfNeeded(messages, {
      sessionKey: 'test-session',
      onStatus: event => {
        statusEvents.push(event);
      },
    });

    assert.match(capturedSummaryInput, /durable answer/);
    assert.doesNotMatch(capturedSummaryInput, /INJECTED_CONTEXT_SHOULD_NOT_BE_SUMMARIZED/);
    assert.doesNotMatch(capturedSummaryInput, /RUNTIME_FEEDBACK_SHOULD_NOT_BE_SUMMARIZED/);
    assert.doesNotMatch(capturedSummaryInput, /SKILL_LIST_SHOULD_NOT_BE_SUMMARIZED/);
    assert.doesNotMatch(capturedSummaryInput, /SUBAGENT_STATUS_SHOULD_NOT_BE_SUMMARIZED/);

    assert.equal(result.some(message => message.content === 'INJECTED_CONTEXT_SHOULD_NOT_BE_SUMMARIZED'), true);
    assert.equal(result.some(message =>
      typeof message.content === 'string'
      && message.content.includes('RUNTIME_FEEDBACK_SHOULD_NOT_BE_SUMMARIZED')
    ), true);
    assert.equal(result.some(message =>
      typeof message.content === 'string'
      && message.content.includes('SKILL_LIST_SHOULD_NOT_BE_SUMMARIZED')
    ), true);
    assert.equal(result.some(message =>
      typeof message.content === 'string'
      && message.content.includes('[以下是之前')
    ), true);
    assert.deepStrictEqual(statusEvents.map(event => event.status), ['start', 'complete']);
    assert.equal(statusEvents[0].sessionKey, 'test-session');
    assert.equal(statusEvents[0].usedTokens > 0, true);
    assert.equal(statusEvents[1].messageCount, result.length);
  });

  test('does not compact when only transient context is large', async () => {
    let aiCalls = 0;
    const aiService = {
      chatStream: async () => {
        aiCalls++;
        return { content: '<summary>unexpected</summary>' };
      },
    } as unknown as AIService;
    const manager = new ContextWindowManager(aiService, {
      maxContextTokens: 1000,
      compactionThreshold: 0.5,
    });
    const messages: Message[] = [
      system('base system'),
      user('short durable input'),
      { role: 'user', content: '中'.repeat(5000), __injected: true },
    ];

    const result = await manager.compactIfNeeded(messages, { sessionKey: 'test-session' });

    assert.equal(result, messages);
    assert.equal(aiCalls, 0);
  });

  test('emits a visible error status and keeps messages when compaction fails', async () => {
    const statusEvents: any[] = [];
    const aiService = {
      chatStream: async () => {
        throw new Error('summary failed');
      },
    } as unknown as AIService;
    const manager = new ContextWindowManager(aiService, {
      maxContextTokens: 1000,
      compactionThreshold: 0.5,
    });
    const messages: Message[] = [
      system('base system'),
      user('中'.repeat(1400)),
      assistant('durable answer'),
    ];

    const result = await manager.compactIfNeeded(messages, {
      sessionKey: 'test-session',
      onStatus: event => {
        statusEvents.push(event);
      },
    });

    assert.equal(result, messages);
    assert.deepStrictEqual(statusEvents.map(event => event.status), ['start', 'error']);
    assert.match(String(statusEvents[1].error), /summary failed/);
  });
});
