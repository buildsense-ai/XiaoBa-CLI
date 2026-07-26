import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from '../src/types';
import type {
  CatsAgentContextMessage,
  CatsAgentContextPage,
} from '../src/catscompany/client';
import {
  CatsCompanyCloudSessionRestorer,
  normalizeAgentContextMessages,
} from '../src/catscompany/cloud-session-restore';
import { estimateMessagesTokens } from '../src/core/token-estimator';

class MemorySessionStore {
  readonly sessions = new Map<string, Message[]>();
  saveCalls = 0;
  loadCalls = 0;

  hasSession(sessionKey: string): boolean {
    return this.sessions.has(sessionKey);
  }

  loadContext(sessionKey: string): Message[] {
    this.loadCalls++;
    return this.sessions.get(sessionKey) || [];
  }

  saveContext(sessionKey: string, messages: Message[]): void {
    this.saveCalls++;
    this.sessions.set(sessionKey, messages);
  }

}

class FakeHistoryClient {
  calls: Array<{ topic: string; beforeId?: number }> = [];

  constructor(private readonly pages: CatsAgentContextPage[] | Error) {}

  async getAgentContextHistory(
    topic: string,
    options: { beforeId?: number } = {},
  ): Promise<CatsAgentContextPage> {
    this.calls.push({ topic, beforeId: options.beforeId });
    if (this.pages instanceof Error) throw this.pages;
    const page = this.pages[this.calls.length - 1];
    if (!page) throw new Error('unexpected history page request');
    return page;
  }
}

const fakeAIService = {
  chatStream: async (_messages: Message[], _tools: unknown, callbacks: { onText?: (text: string) => void }) => {
    callbacks.onText?.('<summary>用户正在迁移设备；此前已经确认继续当前项目。</summary>');
    return {
      content: null,
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    };
  },
} as any;

function contextMessage(overrides: Partial<CatsAgentContextMessage> = {}): CatsAgentContextMessage {
  return {
    id: 1,
    seq_id: 1,
    topic_id: 'p2p_7_42',
    from_uid: 7,
    content: 'hello',
    type: 'text',
    msg_type: 'text',
    agent_uid: 42,
    agent_id: 'usr42',
    context_role: 'user',
    context_eligible: true,
    ...overrides,
  };
}

function page(
  messages: CatsAgentContextMessage[],
  overrides: Partial<CatsAgentContextPage> = {},
): CatsAgentContextPage {
  return {
    messages,
    topic_id: 'p2p_7_42',
    agent_uid: 42,
    has_more: false,
    next_before_id: messages[0]?.id || 0,
    ...overrides,
  };
}

test('existing non-empty local session bypasses cloud history without changing it', async () => {
  const store = new MemorySessionStore();
  const existing: Message[] = [{ role: 'user', content: 'local history' }];
  store.sessions.set('session-key', existing);
  const client = new FakeHistoryClient(new Error('must not fetch'));
  const restorer = new CatsCompanyCloudSessionRestorer(client, fakeAIService, store);

  const result = await restorer.restoreIfMissing({
    sessionKey: 'session-key',
    topicId: 'p2p_7_42',
    topicType: 'p2p',
    agentId: 'usr42',
    currentSeq: 10,
  });

  assert.equal(result.status, 'local_present');
  assert.equal(client.calls.length, 0);
  assert.equal(store.loadCalls, 0);
  assert.equal(store.saveCalls, 0);
  assert.deepEqual(store.sessions.get('session-key'), existing);
});

test('an existing empty session file still wins over cloud history', async () => {
  const store = new MemorySessionStore();
  store.sessions.set('empty-session-file', []);
  const client = new FakeHistoryClient(new Error('must not fetch'));
  const restorer = new CatsCompanyCloudSessionRestorer(client, fakeAIService, store);

  const result = await restorer.restoreIfMissing({
    sessionKey: 'empty-session-file',
    topicId: 'p2p_7_42',
    topicType: 'p2p',
    agentId: 'usr42',
    currentSeq: 10,
  });

  assert.equal(result.status, 'local_present');
  assert.equal(client.calls.length, 0);
  assert.equal(store.loadCalls, 0);
  assert.equal(store.saveCalls, 0);
});

test('missing session restores eligible visible history and paginates oldest-first', async () => {
  const store = new MemorySessionStore();
  const client = new FakeHistoryClient([
    page([
      contextMessage({ id: 3, seq_id: 3, content: 'newer question' }),
      contextMessage({ id: 4, seq_id: 4, from_uid: 42, content: 'part one', context_role: 'assistant' }),
      contextMessage({ id: 5, seq_id: 5, from_uid: 42, content: 'part two', context_role: 'assistant' }),
      contextMessage({ id: 6, seq_id: 6, content: 'working', context_eligible: false }),
    ], { has_more: true, next_before_id: 3 }),
    page([
      contextMessage({ id: 1, seq_id: 1, content: 'older question' }),
      contextMessage({ id: 2, seq_id: 2, from_uid: 42, content: 'older answer', context_role: 'assistant' }),
    ], { next_before_id: 1 }),
  ]);
  const restorer = new CatsCompanyCloudSessionRestorer(client, fakeAIService, store);

  const result = await restorer.restoreIfMissing({
    sessionKey: 'session-key',
    topicId: 'p2p_7_42',
    topicType: 'p2p',
    agentId: 'usr42',
    currentSeq: 7,
  });

  assert.equal(result.status, 'restored');
  assert.deepEqual(client.calls.map(call => call.beforeId), [7, 3]);
  assert.deepEqual(store.sessions.get('session-key')?.map(message => message.content), [
    'older question',
    'older answer',
    'newer question',
    'part one\n\npart two',
  ]);
});

test('group normalization keeps the speaker and rejects another agent scope', () => {
  const normalized = normalizeAgentContextMessages([
    contextMessage({
      topic_id: 'grp_80',
      metadata: {
        catsco_identity: {
          actor: { display_name: 'Alice', user_id: 'usr7' },
        },
      },
    }),
    contextMessage({
      id: 2,
      seq_id: 2,
      topic_id: 'grp_80',
      agent_uid: 43,
      agent_id: 'usr43',
      content: 'wrong agent',
    }),
  ], { topicType: 'group', agentId: 'usr42' });

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].content, '[群聊成员 Alice]\nhello');
});

test('the latest clear command cuts off older cloud history on every device', async () => {
  const store = new MemorySessionStore();
  const client = new FakeHistoryClient([
    page([
      contextMessage({ id: 4, seq_id: 4, content: 'new question' }),
      contextMessage({ id: 5, seq_id: 5, from_uid: 42, content: 'new answer', context_role: 'assistant' }),
    ], { has_more: true, next_before_id: 4 }),
    page([
      contextMessage({ id: 1, seq_id: 1, content: 'old question' }),
      contextMessage({ id: 2, seq_id: 2, from_uid: 42, content: 'old answer', context_role: 'assistant' }),
      contextMessage({ id: 3, seq_id: 3, content: JSON.stringify('/clear') }),
    ], { has_more: true, next_before_id: 1 }),
  ]);
  const restorer = new CatsCompanyCloudSessionRestorer(client, fakeAIService, store);

  const result = await restorer.restoreIfMissing({
    sessionKey: 'cleared-session',
    topicId: 'p2p_7_42',
    topicType: 'p2p',
    agentId: 'usr42',
    currentSeq: 6,
  });

  assert.equal(result.status, 'restored');
  assert.deepEqual(client.calls.map(call => call.beforeId), [6, 4]);
  assert.deepEqual(store.sessions.get('cleared-session')?.map(message => message.content), [
    'new question',
    'new answer',
  ]);
});

test('an ordinary group member saying /clear does not truncate group history', async () => {
  const store = new MemorySessionStore();
  const client = new FakeHistoryClient([
    page([
      contextMessage({ id: 1, seq_id: 1, topic_id: 'grp_80', content: 'old discussion' }),
      contextMessage({ id: 2, seq_id: 2, topic_id: 'grp_80', content: '/clear' }),
      contextMessage({ id: 3, seq_id: 3, topic_id: 'grp_80', content: 'new discussion' }),
    ], { topic_id: 'grp_80' }),
  ]);
  const restorer = new CatsCompanyCloudSessionRestorer(client, fakeAIService, store);

  const result = await restorer.restoreIfMissing({
    sessionKey: 'ordinary-clear-group',
    topicId: 'grp_80',
    topicType: 'group',
    agentId: 'usr42',
    currentSeq: 4,
  });

  assert.equal(result.status, 'restored');
  assert.deepEqual(store.sessions.get('ordinary-clear-group')?.map(message => message.content), [
    '[群聊成员 usr7]\nold discussion',
    '[群聊成员 usr7]\n/clear',
    '[群聊成员 usr7]\nnew discussion',
  ]);
});

test('a group clear targeting the agent truncates older group history', async () => {
  const store = new MemorySessionStore();
  const client = new FakeHistoryClient([
    page([
      contextMessage({ id: 3, seq_id: 3, topic_id: 'grp_80', content: 'new discussion' }),
      contextMessage({
        id: 2,
        seq_id: 2,
        topic_id: 'grp_80',
        content: '/clear --all',
        context_reason: 'group_message_targets_agent',
      }),
      contextMessage({ id: 1, seq_id: 1, topic_id: 'grp_80', content: 'old discussion' }),
    ], { topic_id: 'grp_80' }),
  ]);
  const restorer = new CatsCompanyCloudSessionRestorer(client, fakeAIService, store);

  const result = await restorer.restoreIfMissing({
    sessionKey: 'targeted-clear-group',
    topicId: 'grp_80',
    topicType: 'group',
    agentId: 'usr42',
    currentSeq: 4,
  });

  assert.equal(result.status, 'restored');
  assert.deepEqual(store.sessions.get('targeted-clear-group')?.map(message => message.content), [
    '[群聊成员 usr7]\nnew discussion',
  ]);
});

test('cloud restore sorts a descending history page before rebuilding turns', async () => {
  const store = new MemorySessionStore();
  const client = new FakeHistoryClient([
    page([
      contextMessage({ id: 3, seq_id: 3, content: 'second question' }),
      contextMessage({ id: 2, seq_id: 2, from_uid: 42, content: 'first answer', context_role: 'assistant' }),
      contextMessage({ id: 1, seq_id: 1, content: 'first question' }),
    ]),
  ]);
  const restorer = new CatsCompanyCloudSessionRestorer(client, fakeAIService, store);

  const result = await restorer.restoreIfMissing({
    sessionKey: 'descending-page',
    topicId: 'p2p_7_42',
    topicType: 'p2p',
    agentId: 'usr42',
    currentSeq: 4,
  });

  assert.equal(result.status, 'restored');
  assert.deepEqual(store.sessions.get('descending-page')?.map(message => message.content), [
    'first question',
    'first answer',
    'second question',
  ]);
});

test('cloud assistant history strips internal replay artifacts before summarization', () => {
  const normalized = normalizeAgentContextMessages([
    contextMessage({
      from_uid: 42,
      context_role: 'assistant',
      content: '[历史工具调用已完成；provider replay 隐藏内容未写入本地会话。]',
    }),
  ], { topicType: 'p2p', agentId: 'usr42' });

  assert.deepEqual(normalized, []);
});

test('content-block-only attachments retain safe historical placeholders', () => {
  const normalized = normalizeAgentContextMessages([
    contextMessage({
      content: undefined,
      content_blocks: [{ type: 'image', source: { data: 'must-not-leak' } }],
    }),
  ], { topicType: 'p2p', agentId: 'usr42' });

  assert.equal(normalized[0]?.content, '[历史图片]');
  assert.doesNotMatch(JSON.stringify(normalized), /must-not-leak/);
});

test('markLocalSessionCleared persists an empty sentinel after a regular clear', () => {
  const store = new MemorySessionStore();
  store.sessions.set('session-key', [{ role: 'user', content: 'old history' }]);
  const restorer = new CatsCompanyCloudSessionRestorer(
    new FakeHistoryClient([]),
    fakeAIService,
    store,
  );

  restorer.markLocalSessionCleared('session-key');

  assert.equal(store.hasSession('session-key'), true);
  assert.deepEqual(store.sessions.get('session-key'), []);
  assert.equal(store.saveCalls, 1);
});

test('large cloud transcript is summarized before it is persisted', async () => {
  const store = new MemorySessionStore();
  const large = 'x'.repeat(260_000);
  const client = new FakeHistoryClient([
    page([
      contextMessage({ content: large }),
      contextMessage({ id: 2, seq_id: 2, from_uid: 42, content: 'recent answer', context_role: 'assistant' }),
    ]),
  ]);
  const restorer = new CatsCompanyCloudSessionRestorer(client, fakeAIService, store);

  const result = await restorer.restoreIfMissing({
    sessionKey: 'large-session',
    topicId: 'p2p_7_42',
    topicType: 'p2p',
    agentId: 'usr42',
    currentSeq: 3,
  });

  assert.equal(result.status, 'restored');
  assert.equal(result.compressed, true);
  const restored = store.sessions.get('large-session') || [];
  assert.ok(restored.some(message => String(message.content).includes('用户正在迁移设备')));
  assert.ok(restored.some(message => String(message.content).includes('recent answer')));
});

test('summary failure still bounds a single oversized history message', async () => {
  const store = new MemorySessionStore();
  const client = new FakeHistoryClient([
    page([contextMessage({ content: 'x'.repeat(400_000) })]),
  ]);
  const failingAIService = {
    chatStream: async () => {
      throw new Error('summary unavailable');
    },
  } as any;
  const restorer = new CatsCompanyCloudSessionRestorer(client, failingAIService, store);

  const result = await restorer.restoreIfMissing({
    sessionKey: 'oversized-session',
    topicId: 'p2p_7_42',
    topicType: 'p2p',
    agentId: 'usr42',
    currentSeq: 2,
  });

  assert.equal(result.status, 'restored');
  assert.equal(result.compressed, true);
  const restored = store.sessions.get('oversized-session') || [];
  assert.ok(estimateMessagesTokens(restored) <= 60_000);
  assert.match(String(restored[0]?.content), /设备恢复提示/);
  assert.match(String(restored[1]?.content), /已截断/);
});

test('summary timeout persists the bounded fallback instead of failing every retry', async () => {
  const store = new MemorySessionStore();
  const client = new FakeHistoryClient([
    page([contextMessage({ content: 'x'.repeat(400_000) })]),
  ]);
  const timedOutAIService = {
    chatStream: async (
      _messages: Message[],
      _tools: unknown,
      _callbacks: unknown,
      options: { signal?: AbortSignal } = {},
    ) => await new Promise((_resolve, reject) => {
      const signal = options.signal;
      if (!signal) {
        reject(new Error('missing summary timeout signal'));
        return;
      }
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  } as any;
  const restorer = new CatsCompanyCloudSessionRestorer(client, timedOutAIService, store);

  const result = await restorer.restoreIfMissing({
    sessionKey: 'summary-timeout-session',
    topicId: 'p2p_7_42',
    topicType: 'p2p',
    agentId: 'usr42',
    currentSeq: 2,
    signal: AbortSignal.timeout(10),
  });

  assert.equal(result.status, 'restored');
  assert.equal(result.compressed, true);
  assert.equal(store.saveCalls, 1);
  const restored = store.sessions.get('summary-timeout-session') || [];
  assert.ok(estimateMessagesTokens(restored) <= 60_000);
  assert.match(String(restored[0]?.content), /设备恢复提示/);
});

test('explicit cancellation during summary still prevents stale history persistence', async () => {
  const store = new MemorySessionStore();
  const client = new FakeHistoryClient([
    page([contextMessage({ content: 'x'.repeat(400_000) })]),
  ]);
  let summaryStarted!: () => void;
  const summaryStartedPromise = new Promise<void>(resolve => { summaryStarted = resolve; });
  const cancelledAIService = {
    chatStream: async (
      _messages: Message[],
      _tools: unknown,
      _callbacks: unknown,
      options: { signal?: AbortSignal } = {},
    ) => await new Promise((_resolve, reject) => {
      summaryStarted();
      const signal = options.signal;
      if (!signal) {
        reject(new Error('missing cancellation signal'));
        return;
      }
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  } as any;
  const controller = new AbortController();
  const restorer = new CatsCompanyCloudSessionRestorer(client, cancelledAIService, store);

  const restoring = restorer.restoreIfMissing({
    sessionKey: 'summary-cancelled-session',
    topicId: 'p2p_7_42',
    topicType: 'p2p',
    agentId: 'usr42',
    currentSeq: 2,
    signal: controller.signal,
  });
  await summaryStartedPromise;
  controller.abort();
  const result = await restoring;

  assert.equal(result.status, 'failed');
  assert.equal(store.hasSession('summary-cancelled-session'), false);
  assert.equal(store.saveCalls, 0);
});

test('history failure leaves the local session untouched for a later retry', async () => {
  const store = new MemorySessionStore();
  const client = new FakeHistoryClient(new Error('offline'));
  const restorer = new CatsCompanyCloudSessionRestorer(client, fakeAIService, store);

  const result = await restorer.restoreIfMissing({
    sessionKey: 'missing-session',
    topicId: 'p2p_7_42',
    topicType: 'p2p',
    agentId: 'usr42',
    currentSeq: 3,
  });

  assert.equal(result.status, 'failed');
  assert.equal(store.hasSession('missing-session'), false);
  assert.equal(store.saveCalls, 0);
});

test('an aborted cloud restore cannot recreate a session after clear', async () => {
  const store = new MemorySessionStore();
  let releaseHistory!: () => void;
  let historyStarted!: () => void;
  const historyStartedPromise = new Promise<void>(resolve => { historyStarted = resolve; });
  const historyGate = new Promise<void>(resolve => { releaseHistory = resolve; });
  const client = {
    async getAgentContextHistory() {
      historyStarted();
      await historyGate;
      return page([contextMessage({ content: 'old cloud history' })]);
    },
  };
  const controller = new AbortController();
  const restorer = new CatsCompanyCloudSessionRestorer(client, fakeAIService, store);

  const restoring = restorer.restoreIfMissing({
    sessionKey: 'cleared-during-restore',
    topicId: 'p2p_7_42',
    topicType: 'p2p',
    agentId: 'usr42',
    currentSeq: 2,
    signal: controller.signal,
  });
  await historyStartedPromise;
  controller.abort();
  releaseHistory();

  const result = await restoring;
  assert.equal(result.status, 'failed');
  assert.equal(store.hasSession('cleared-during-restore'), false);
  assert.equal(store.saveCalls, 0);
});
