import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import {
  buildSessionKeyV2,
  createCatsCoSessionRoute,
  createFeishuBridgeSessionRoute,
  createFeishuSessionRoute,
  createWeixinSessionRoute,
  parseSessionKeyV2,
} from '../src/core/session-router';
import { createCatsCoMessageEnvelope } from '../src/catscompany/message-envelope';

describe('SessionRoute V2', () => {
  test('builds distinct canonical keys for the same raw actor across channels', () => {
    const catsEnvelope = createCatsCoMessageEnvelope({
      topic: 'p2p_shared_bot',
      senderId: 'shared',
      text: 'cats',
      botUid: 'bot',
      metadata: {
        catsco_identity: {
          actor: { user_id: 'shared' },
          agent: { agent_id: 'bot', body_id: 'body-main' },
          topic: { topic_id: 'p2p_shared_bot', type: 'p2p', channel_seq: 1 },
          permissions: { source: 'server_canonical_message' },
        },
      },
    });
    const catsRoute = createCatsCoSessionRoute(catsEnvelope);
    const feishuRoute = createFeishuSessionRoute({
      messageId: 'msg-feishu',
      chatId: 'shared',
      chatType: 'p2p',
      senderId: 'shared',
      text: 'feishu',
      mentionBot: false,
      msgType: 'text',
    });
    const weixinRoute = createWeixinSessionRoute({
      message_id: 'msg-weixin',
      from: { id: 'shared' },
      chat: { id: 'bot' },
      text: 'weixin',
      context_token: 'ctx',
    });

    assert.notEqual(catsRoute.sessionKey, feishuRoute.sessionKey);
    assert.notEqual(feishuRoute.sessionKey, weixinRoute.sessionKey);
    assert.notEqual(catsRoute.sessionKey, weixinRoute.sessionKey);
    assert.equal(catsRoute.legacySessionKey, 'cc_user:shared');
    assert.equal(feishuRoute.legacySessionKey, 'user:shared');
    assert.equal(weixinRoute.legacySessionKey, 'user:shared');
  });

  test('parses V2 keys without losing source or topic type', () => {
    const key = buildSessionKeyV2({
      source: 'feishu',
      topicType: 'group',
      topicId: 'oc_group:with:colon',
    });

    assert.deepEqual(parseSessionKeyV2(key), {
      version: 2,
      source: 'feishu',
      topicType: 'group',
      topicId: 'oc_group:with:colon',
      agentId: undefined,
    });
  });

  test('keeps CatsCo route trust aligned with the envelope instead of upgrading legacy messages', () => {
    const envelope = createCatsCoMessageEnvelope({
      topic: 'p2p_7_43',
      senderId: 'usr7',
      text: 'legacy',
      botUid: 'usr43',
    });
    const route = createCatsCoSessionRoute(envelope);

    assert.equal(route.sessionKey, 'session:v2:catscompany:p2p:p2p_7_43:agent:usr43');
    assert.equal(route.legacySessionKey, 'cc_user:usr7');
    assert.equal(route.identityTrust, 'legacy_context');
    assert.equal(route.identity.identityTrust, 'legacy_context');
  });

  test('uses the legacy CatsCo group session key', () => {
    const envelope = createCatsCoMessageEnvelope({
      topic: 'grp_80',
      isGroup: true,
      senderId: 'usr7',
      text: 'group',
      botUid: 'usr43',
      metadata: {
        catsco_identity: {
          actor: { user_id: 'usr7' },
          agent: { agent_id: 'usr43', body_id: 'body-main' },
          topic: { topic_id: 'grp_80', type: 'group', channel_seq: 1 },
          permissions: { source: 'server_canonical_message' },
        },
      },
    });
    const route = createCatsCoSessionRoute(envelope);

    assert.equal(route.sessionKey, 'cc_group:grp_80');
    assert.equal(route.legacySessionKey, 'cc_group:grp_80');
    assert.equal(route.legacyRestoreKey, 'cc_group:grp_80');
    assert.equal(route.legacyCleanupKey, 'cc_group:grp_80');
  });

  test('routes Feishu bridge broadcasts as group conversations', () => {
    const route = createFeishuBridgeSessionRoute({
      chatId: 'oc_group',
      from: 'ResearchBot',
      messageId: 'bridge-1',
    });

    assert.equal(route.sessionKey, 'session:v2:feishu:group:oc_group');
    assert.equal(route.legacySessionKey, 'group:oc_group');
    assert.equal(route.actorUserId, 'ResearchBot');
    assert.equal(route.topicType, 'group');
  });
});
