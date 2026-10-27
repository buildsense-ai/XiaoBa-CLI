import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { createCatsCoMessageEnvelope } from '../src/catscompany/message-envelope';

/**
 * 「一次工具调用一个会话」。
 *
 * 平台把另一个 Agent 的活派给这个 bot 时会带 `catsco_bot_session_id`。
 * 平台的 topic 是固定的 `p2p_调用方_bot`，所以不带这个 id 的话，所有调用会挤在
 * 同一条会话里 —— 上一个任务的判断会漏到下一个任务（「按 Asia/Shanghai 算」
 * 这种上游决定会污染下一个问题的答案）。
 */

function trustedMetadata(topicId: string, channelSeq: number, extra: Record<string, unknown> = {}) {
  return {
    ...extra,
    catsco_identity: {
      actor: { user_id: 'usr38' },
      agent: { agent_id: 'usr982' },
      topic: { topic_id: topicId, type: 'p2p', channel_seq: channelSeq },
      permissions: { source: 'server_canonical_message' },
    },
  };
}

describe('CatsCo bot call sessions', () => {
  test('平台派活时按会话 id 分会话，而不是按 topic', () => {
    const topic = 'p2p_38_982';
    const runA = createCatsCoMessageEnvelope({
      topic,
      senderId: 'usr38',
      seq: 501,
      text: '查 A',
      botUid: 'usr982',
      metadata: trustedMetadata(topic, 501, { catsco_bot_session_id: 'sess_a' }),
    });
    const runB = createCatsCoMessageEnvelope({
      topic,
      senderId: 'usr38',
      seq: 502,
      text: '查 B',
      botUid: 'usr982',
      metadata: trustedMetadata(topic, 502, { catsco_bot_session_id: 'sess_b' }),
    });

    assert.equal(runA.botSessionId, 'sess_a');
    assert.equal(runB.botSessionId, 'sess_b');
    // 同一个 topic，两个会话：上一个任务的上下文不会漏到下一个任务。
    assert.equal(runA.topicId, runB.topicId);
    assert.notEqual(runA.sessionKey, runB.sessionKey);
  });

  test('同一个会话 id 回到同一个会话（追问能接上）', () => {
    const topic = 'p2p_38_982';
    const first = createCatsCoMessageEnvelope({
      topic,
      senderId: 'usr38',
      seq: 601,
      text: '查 A',
      botUid: 'usr982',
      metadata: trustedMetadata(topic, 601, { catsco_bot_session_id: 'sess_a' }),
    });
    const follow = createCatsCoMessageEnvelope({
      topic,
      senderId: 'usr38',
      seq: 602,
      text: '再细一点',
      botUid: 'usr982',
      metadata: trustedMetadata(topic, 602, { catsco_bot_session_id: 'sess_a' }),
    });

    assert.equal(first.sessionKey, follow.sessionKey);
  });

  test('真人聊天不带会话 id：保持按 topic 分会话的老行为', () => {
    const topic = 'p2p_38_982';
    const human = createCatsCoMessageEnvelope({
      topic,
      senderId: 'usr38',
      seq: 700,
      text: '在吗',
      botUid: 'usr982',
      metadata: trustedMetadata(topic, 700),
    });

    assert.equal(human.botSessionId, undefined);
    // 会话身份里不含派活标记 = 与「同一个 topic 下的工具调用」分开
    const call = createCatsCoMessageEnvelope({
      topic,
      senderId: 'usr38',
      seq: 701,
      text: '查 A',
      botUid: 'usr982',
      metadata: trustedMetadata(topic, 701, { catsco_bot_session_id: 'sess_a' }),
    });
    assert.notEqual(human.sessionKey, call.sessionKey);
  });

  test('不可信信封里的会话 id 一律不采纳', () => {
    // 没有平台签名的 catsco_identity：任何人都能塞 metadata，
    // 采纳等于让人凭一个字符串无限开新会话（把上下文隔离变成 DoS 面）。
    const spoofed = createCatsCoMessageEnvelope({
      topic: 'p2p_38_982',
      senderId: 'usr38',
      seq: 800,
      text: '查 A',
      botUid: 'usr982',
      metadata: { catsco_bot_session_id: 'sess_attacker' },
    });

    assert.equal(spoofed.botSessionId, undefined);
  });

  test('会话 id 与真实 topic 不会撞车', () => {
    const viaCall = createCatsCoMessageEnvelope({
      topic: 'p2p_38_982',
      senderId: 'usr38',
      seq: 900,
      text: '查 A',
      botUid: 'usr982',
      metadata: trustedMetadata('p2p_38_982', 900, { catsco_bot_session_id: 'p2p_38_983' }),
    });
    // 即使有人把会话 id 起成 topic 的形状，也不会等于「真的在 p2p_38_983 里聊」。
    const realTopic = createCatsCoMessageEnvelope({
      topic: 'p2p_38_983',
      senderId: 'usr38',
      seq: 901,
      text: '在吗',
      botUid: 'usr982',
      metadata: trustedMetadata('p2p_38_983', 901),
    });

    assert.notEqual(viaCall.sessionKey, realTopic.sessionKey);
  });
});
