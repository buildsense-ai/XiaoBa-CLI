import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { loadCatsCompanyGroupActivationContext } from '../src/catscompany/jev-group-context';
import type { CatsAgentContextMessage, CatsAgentContextPage } from '../src/catscompany/client';

function message(seq: number, text: string, overrides: Partial<CatsAgentContextMessage> = {}): CatsAgentContextMessage {
  return {
    id: seq, seq_id: seq, topic_id: 'grp_80', from_uid: 7,
    agent_uid: 43, agent_id: 'usr43', type: 'text', content: text,
    context_role: 'user', context_eligible: true, context_reason: 'participant_message',
    ...overrides,
  };
}

function page(messages: CatsAgentContextMessage[], overrides: Partial<CatsAgentContextPage> = {}): CatsAgentContextPage {
  return {
    topic_id: 'grp_80', agent_uid: 43, messages,
    has_more: false, next_before_id: 0, ...overrides,
  };
}

describe('CatsCompany JEV pre-turn context', () => {
  test('reads one page strictly before the trigger and keeps ten bounded, eligible text messages', async () => {
    let calls = 0;
    const client = { getAgentContextHistory: async (topic: string, options: any) => {
      calls++;
      assert.equal(topic, 'grp_80');
      assert.equal(options.beforeId, 40);
      assert.equal(options.limit, 20);
      assert.equal(options.signal.aborted, false);
      return page([
        ...Array.from({ length: 12 }, (_, index) => message(21 + index, `text ${index}${'z'.repeat(500)}`)),
        message(33, 'not addressed to this bot', {
          context_eligible: false, context_reason: 'group_message_targets_another_member',
        }),
        message(34, 'attachment metadata', { type: 'file' }),
        message(36, 'different group', { topic_id: 'grp_other' }),
        message(35, 'bot earlier reply', { context_role: 'assistant', from_uid: 43 }),
        message(40, 'current message'),
        message(41, 'future message'),
      ]);
    } };
    const context = await loadCatsCompanyGroupActivationContext(client, 'grp_80', 40, 'usr43', AbortSignal.timeout(600));
    assert.equal(calls, 1);
    assert.equal(context.length, 10);
    assert.deepEqual(context.map(entry => entry.seq), [24, 25, 26, 27, 28, 29, 30, 31, 32, 35]);
    assert.equal(context.at(-1)?.role, 'assistant');
    assert.ok(context.every(entry => entry.text.length <= 350));
  });

  test('does not read across a /clear boundary or forward untrusted history', async () => {
    const client = { getAgentContextHistory: async () => page([
      message(10, 'old confidential context'),
      message(11, '/clear', { context_reason: 'group_message_targets_agent' }),
      message(12, 'new context'),
    ]) };
    const context = await loadCatsCompanyGroupActivationContext(client, 'grp_80', 20, '43', AbortSignal.timeout(600));
    assert.deepEqual(context.map(entry => entry.seq), [12]);
  });

  test('rejects wrong topic, agent or missing sequence instead of using another scope', async () => {
    const wrongTopic = { getAgentContextHistory: async () => page([], { topic_id: 'grp_other' }) };
    await assert.rejects(() => loadCatsCompanyGroupActivationContext(wrongTopic, 'grp_80', 20, 'usr43', AbortSignal.timeout(600)), /scope mismatch/);
    const wrongAgent = { getAgentContextHistory: async () => page([], { agent_uid: 42 }) };
    await assert.rejects(() => loadCatsCompanyGroupActivationContext(wrongAgent, 'grp_80', 20, 'usr43', AbortSignal.timeout(600)), /scope mismatch/);
    await assert.rejects(() => loadCatsCompanyGroupActivationContext(wrongAgent, 'grp_80', 0, 'usr43', AbortSignal.timeout(600)), /current sequence/);
  });
});
