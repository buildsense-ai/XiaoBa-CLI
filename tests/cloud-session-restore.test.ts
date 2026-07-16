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

  hasSession(sessionKey: string): boolean {
    return this.sessions.has(sessionKey);
  }

  loadContext(sessionKey: string): Message[] {
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
  assert.equal(store.saveCalls, 0);
  assert.deepEqual(store.sessions.get('session-key'), existing);
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

test('history failure leaves the local session untouched and allows a normal empty start', async () => {
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
