import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { shouldActivateCatsCompanyMessage } from '../src/catscompany';

function canonicalChannelMessage(triggered: boolean, overrides: Record<string, unknown> = {}) {
  return {
    isGroup: true,
    topic: 'grp_9',
    senderId: 'usr7',
    seq: 17,
    mentions: ['usr43'],
    metadata: {
      source_channel: 'feishu',
      channel_native_group_binding_id: 12,
      channel_native_group_triggered: triggered,
      catsco_identity: {
        actor: { user_id: 'usr7' },
        agent: { agent_id: 'usr43' },
        topic: { topic_id: 'grp_9', type: 'group' },
        permissions: { source: 'server_canonical_message' },
      },
      ...overrides,
    },
  };
}

describe('CatsCompany group activation gate', () => {
  test('keeps p2p and two-member group behavior automatic', () => {
    assert.equal(shouldActivateCatsCompanyMessage({ isGroup: false }, 'usr43'), true);
    assert.equal(shouldActivateCatsCompanyMessage({ isGroup: true, memberCount: 2 }, 'usr43'), true);
  });

  test('requires the current AI in structured mentions for larger groups', () => {
    assert.equal(shouldActivateCatsCompanyMessage({ isGroup: true, memberCount: 4 }, 'usr43'), false);
    assert.equal(shouldActivateCatsCompanyMessage({ isGroup: true, memberCount: 4, mentions: ['usr42'] }, 'usr43'), false);
    assert.equal(shouldActivateCatsCompanyMessage({ isGroup: true, memberCount: 4, mentions: ['usr43'] }, '43'), true);
  });

  test('fails closed when group size is missing or malformed unless the current AI is targeted', () => {
    assert.equal(shouldActivateCatsCompanyMessage({ isGroup: true }, 'usr43'), false);
    assert.equal(shouldActivateCatsCompanyMessage({ isGroup: true, memberCount: 1.5 }, 'usr43'), false);
    assert.equal(shouldActivateCatsCompanyMessage({ isGroup: true, memberCount: '2' } as any, 'usr43'), false);
    assert.equal(shouldActivateCatsCompanyMessage({ isGroup: true, memberCount: Number.MAX_SAFE_INTEGER + 1 }, 'usr43'), false);
    assert.equal(shouldActivateCatsCompanyMessage({ isGroup: true, mentions: ['usr43'] }, 'usr43'), true);
    assert.equal(shouldActivateCatsCompanyMessage({
      isGroup: true,
      memberCount: 1.5,
      mentions: ['usr43'],
    }, 'usr43'), true);
  });

  test('trusts only the structured channel trigger flag for externally managed groups', () => {
    assert.equal(shouldActivateCatsCompanyMessage(canonicalChannelMessage(false), 'usr43'), false);
    assert.equal(shouldActivateCatsCompanyMessage(canonicalChannelMessage(true), 'usr43'), true);
    assert.equal(shouldActivateCatsCompanyMessage({
      isGroup: true,
      topic: 'grp_9',
      senderId: 'usr7',
      metadata: { source_channel: 'feishu', channel_native_group_triggered: true },
    }, 'usr43'), false);
  });

  test('binds external activation to actor, topic, Agent, permissions, and native binding', () => {
    const cases = [
      canonicalChannelMessage(true, {
        catsco_identity: {
          actor: { user_id: 'usr99' },
          agent: { agent_id: 'usr43' },
          topic: { topic_id: 'grp_9', type: 'group' },
          permissions: { source: 'server_canonical_message' },
        },
      }),
      canonicalChannelMessage(true, {
        catsco_identity: {
          actor: { user_id: 'usr7' },
          agent: { agent_id: 'usr43' },
          topic: { topic_id: 'grp_other', type: 'group' },
          permissions: { source: 'server_canonical_message' },
        },
      }),
      canonicalChannelMessage(true, {
        catsco_identity: {
          actor: { user_id: 'usr7' },
          agent: { agent_id: 'usr99' },
          topic: { topic_id: 'grp_9', type: 'group' },
          permissions: { source: 'server_canonical_message' },
        },
      }),
      canonicalChannelMessage(true, {
        catsco_identity: {
          actor: { user_id: 'usr7' },
          agent: { agent_id: 'usr43' },
          topic: { topic_id: 'grp_9', type: 'group' },
          permissions: { source: 'client_claim' },
        },
      }),
      canonicalChannelMessage(true, { channel_native_group_binding_id: 0 }),
      { ...canonicalChannelMessage(true), mentions: undefined },
      { ...canonicalChannelMessage(true), mentions: ['usr99'] },
    ];

    for (const message of cases) {
      assert.equal(shouldActivateCatsCompanyMessage(message as any, 'usr43'), false);
    }
  });
});
