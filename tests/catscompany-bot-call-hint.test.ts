import { describe, test } from 'node:test';
import * as assert from 'node:assert';
import { createCatsCoMessageEnvelope } from '../src/catscompany/message-envelope';
import { TRANSIENT_BOT_CALL_HINT_PREFIX, buildBotCallHintMessage } from '../src/core/bot-call-hint';
import { TurnContextBuilder } from '../src/core/turn-context-builder';

/**
 * 平台把这个 bot 当工具调时，本轮要告诉模型「对方看不到你这台机器」。
 *
 * 起因是实测：模型把结果写成「报告已生成：/tmp/report.pdf」，调用方只能拿到这串
 * 字符，文件还留在 bot 机器上，两边都看不出发生过什么。
 *
 * 关键约束是**只在那一轮**：同一会话里人可以接着聊同样的活，那时这句话是错的
 * （对面就坐在屏幕前，看得见文件）。
 */

const canonicalIdentity = (topicId: string, actorId: string) => ({
  actor: { user_id: actorId },
  agent: { agent_id: 'usr982' },
  topic: { topic_id: topicId, type: 'p2p' },
  permissions: { source: 'server_canonical_message' },
});

function envelopeWith(metadata: Record<string, unknown>) {
  const topic = 'p2p_38_982';
  return createCatsCoMessageEnvelope({
    topic,
    senderId: 'usr38',
    text: '给我一份报告',
    botUid: '982',
    metadata: {
      ...metadata,
      catsco_identity: canonicalIdentity(topic, 'usr38'),
    },
  });
}

describe('CatsCompany 派活标记', () => {
  test('可信信封里 catsco_bot_call=true → dispatchedAsTool', () => {
    assert.equal(envelopeWith({ catsco_bot_call: true }).dispatchedAsTool, true);
    // 平台历史上两种写法都出现过，字符串形态也要认。
    assert.equal(envelopeWith({ catsco_bot_call: 'true' }).dispatchedAsTool, true);
  });

  test('没有这个标记就是普通聊天', () => {
    assert.equal(envelopeWith({}).dispatchedAsTool, false);
    assert.equal(envelopeWith({ catsco_bot_call: false }).dispatchedAsTool, false);
    assert.equal(envelopeWith({ catsco_bot_call: 'false' }).dispatchedAsTool, false);
    // 别把别的字段误认成它。
    assert.equal(envelopeWith({ catsco_bot_session_id: 'sess_x' }).dispatchedAsTool, false);
  });

  test('不可信信封里一律不采纳（客户端不能自报「我在被 Agent 调用」）', () => {
    const topic = 'p2p_38_982';
    const forged = createCatsCoMessageEnvelope({
      topic,
      senderId: 'usr38',
      text: '给我一份报告',
      botUid: '982',
      metadata: { catsco_bot_call: true },
    });
    assert.equal(forged.dispatchedAsTool, false);
    assert.notEqual(forged.identityTrust, 'server_canonical');
  });

  test('提示文本本身说清了「对方看不到你的机器」和 send_file', () => {
    const content = String(buildBotCallHintMessage().content);
    assert.ok(content.startsWith(TRANSIENT_BOT_CALL_HINT_PREFIX));
    assert.match(content, /另一个 Agent/);
    assert.match(content, /看不到你这台机器/);
    assert.match(content, /send_file/);
  });
});

describe('派活提示只在那一轮出现', () => {
  const builder = new TurnContextBuilder();

  function buildParams(dispatchedAsTool: boolean | undefined) {
    const topic = 'p2p_38_982';
    const envelope = createCatsCoMessageEnvelope({
      topic,
      senderId: 'usr38',
      text: '给我一份报告',
      botUid: '982',
      metadata: {
        catsco_bot_call: true,
        catsco_identity: canonicalIdentity(topic, 'usr38'),
      },
    });
    return {
      sessionKey: 'session:test',
      sessionType: 'catscompany',
      executionScope: { source: 'catscompany' as const, sessionKey: 'session:test', topicId: topic },
      durableMessages: [{ role: 'user' as const, content: '给我一份报告' }],
      runtimeFeedback: [],
      skillRuntime: {
        reloadSkills: async () => {},
        buildSkillsListMessage: () => null,
      } as any,
      dispatchedAsTool: dispatchedAsTool ?? envelope.dispatchedAsTool,
    };
  }

  test('派活那一轮注入提示', async () => {
    const { messages } = await builder.build(buildParams(true) as any);
    const hint = messages.find(
      m => typeof m.content === 'string' && m.content.startsWith(TRANSIENT_BOT_CALL_HINT_PREFIX),
    );
    assert.ok(hint, `应注入派活提示，实际消息：${JSON.stringify(messages.map(m => String(m.content).slice(0, 40)))}`);
  });

  test('普通聊天不注入', async () => {
    const { messages } = await builder.build(buildParams(false) as any);
    const hint = messages.find(
      m => typeof m.content === 'string' && m.content.startsWith(TRANSIENT_BOT_CALL_HINT_PREFIX),
    );
    assert.equal(hint, undefined);
  });

  test('提示不会被写进历史：下一轮重建时已经消失', async () => {
    const first = await builder.build(buildParams(true) as any);
    const hasHint = (msgs: ReadonlyArray<{ content: unknown }>) => msgs.some(
      m => typeof m.content === 'string' && m.content.startsWith(TRANSIENT_BOT_CALL_HINT_PREFIX),
    );
    assert.ok(hasHint(first.messages), '第一轮应该有');

    // 模拟「上一轮的上下文（含提示）被留存下来」：第二轮用它当历史重建。
    const second = await builder.build({
      ...(buildParams(false) as any),
      durableMessages: first.messages,
    });
    assert.equal(hasHint(second.messages), false, '历史里残留的提示必须被过滤掉');
  });
});
